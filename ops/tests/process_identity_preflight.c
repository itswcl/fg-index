#define _GNU_SOURCE
/* Disposable stage-zero probe: self state and proc visibility only. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/capability.h>
#include <linux/seccomp.h>
#include <linux/prctl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef __linux__
#error Linux-only feasibility fixture
#endif

#define MAX_FDINFO_BYTES (64U * 1024U)

static int fail_errno(const char *operation, int error) {
    dprintf(STDERR_FILENO, "self-observation=FAIL operation=%s errno=%d (%s)\n",
            operation, error, strerror(error));
    return 1;
}

static int fail_check(const char *operation) {
    dprintf(STDERR_FILENO, "self-observation=FAIL operation=%s\n", operation);
    return 1;
}

static int bounded_namespace_observation_window(void) {
    struct timespec deadline;
    if (clock_gettime(CLOCK_MONOTONIC, &deadline) != 0)
        return fail_errno("clock_gettime-monotonic", errno);
    deadline.tv_sec += 2;
    int result;
    do {
        result = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &deadline, NULL);
    } while (result == EINTR);
    if (result != 0) return fail_errno("clock_nanosleep-two-second-window", result);
    return 0;
}

static int deny_post_entry_exec(void) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execve, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
#ifdef SYS_execveat
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execveat, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
        .filter = instructions,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail_errno("prctl-set-no-new-privileges", errno);
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) return fail_errno("prctl-deny-post-entry-exec", errno);
    char *argv[] = {"/nonexistent-post-entry-exec-probe", NULL};
    char *envp[] = {NULL};
    errno = 0;
    if (execve(argv[0], argv, envp) != -1 || errno != EPERM) return fail_check("post-entry-exec-not-denied");
    return 0;
}

static int observe_capabilities(void) {
    struct __user_cap_header_struct header = {
        .version = _LINUX_CAPABILITY_VERSION_3,
        .pid = 0,
    };
    struct __user_cap_data_struct data[2] = {{0}};
    int failures = 0;
    if (syscall(SYS_capget, &header, data) != 0) {
        failures += fail_errno("capget-effective-permitted-inheritable", errno);
    } else {
        for (size_t i = 0; i < 2; ++i) {
            if (data[i].effective || data[i].permitted || data[i].inheritable)
                failures += fail_check("capget-nonempty-capability-set");
        }
    }

    for (int capability = 0; capability <= CAP_LAST_CAP; ++capability) {
        errno = 0;
        int bounded = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
        if (bounded < 0) failures += fail_errno("prctl-capability-bounding-read", errno);
        else if (bounded != 0) failures += fail_check("prctl-nonempty-capability-bounding-set");

        errno = 0;
        int ambient = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0);
        if (ambient < 0) failures += fail_errno("prctl-capability-ambient-read", errno);
        else if (ambient != 0) failures += fail_check("prctl-nonempty-ambient-capability-set");
    }
    return failures;
}

static int observe_fdinfo(size_t *count) {
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return fail_errno("opendir-/proc/self/fd", errno);
    int enumeration_fd = dirfd(directory);
    struct dirent *entry;
    *count = 0; int failures = 0;
    for (;;) {
        errno = 0;
        entry = readdir(directory);
        if (!entry) {
            if (errno) failures += fail_errno("readdir-/proc/self/fd", errno);
            break;
        }
        char *end = NULL;
        long descriptor = strtol(entry->d_name, &end, 10);
        if (errno || end == entry->d_name || *end || descriptor < 0 || descriptor == enumeration_fd)
            continue;

        char path[128], target[4096], data[1024];
        int length = snprintf(path, sizeof(path), "/proc/self/fd/%ld", descriptor);
        if (length < 0 || (size_t)length >= sizeof(path)) {
            failures += fail_check("format-/proc/self/fd-path"); continue;
        }
        ssize_t link_length = readlink(path, target, sizeof(target) - 1);
        if (link_length < 0) {
            failures += fail_errno(path, errno); continue;
        }
        if ((size_t)link_length >= sizeof(target) - 1) {
            failures += fail_errno(path, ENAMETOOLONG); continue;
        }
        target[link_length] = '\0';
        length = snprintf(path, sizeof(path), "/proc/self/fdinfo/%ld", descriptor);
        if (length < 0 || (size_t)length >= sizeof(path)) {
            failures += fail_check("format-/proc/self/fdinfo-path"); continue;
        }
        int fd = open(path, O_RDONLY | O_CLOEXEC);
        if (fd < 0) {
            failures += fail_errno(path, errno); continue;
        }
        size_t total = 0;
        int fdinfo_failed = 0;
        for (;;) {
            char overflow_byte;
            size_t available = total == MAX_FDINFO_BYTES ? 1 :
                (MAX_FDINFO_BYTES - total < sizeof(data) ? MAX_FDINFO_BYTES - total : sizeof(data));
            char *buffer = total == MAX_FDINFO_BYTES ? &overflow_byte : data;
            errno = 0;
            ssize_t bytes = read(fd, buffer, available);
            if (bytes < 0 && errno == EINTR) continue;
            if (bytes < 0) { failures += fail_errno(path, errno); fdinfo_failed = 1; break; }
            if (bytes == 0) {
                if (total == 0) { failures += fail_errno(path, EIO); fdinfo_failed = 1; }
                break;
            }
            if (total == MAX_FDINFO_BYTES) {
                failures += fail_errno(path, EOVERFLOW); fdinfo_failed = 1; break;
            }
            total += (size_t)bytes;
        }
        close(fd);
        if (fdinfo_failed) continue;
        ++*count;
    }
    closedir(directory);
    if (!*count) failures += fail_check("empty-/proc/self/fd-enumeration");
    return failures;
}

int main(void) {
    /* Required first operation: no argv, environment, or proc reads before this. */
    int failures = 0;
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) failures += fail_errno("prctl-set-dumpable-zero", errno);
    int dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
    if (dumpable < 0) failures += fail_errno("prctl-get-dumpable", errno);
    else if (dumpable != 0) failures += fail_check("dumpability-not-zero");
    int capability_failures = observe_capabilities();
    failures += capability_failures;
    int exec_failures = deny_post_entry_exec();
    failures += exec_failures;
    dprintf(STDOUT_FILENO,
            "scope=self-proc-visibility-only uid=%u gid=%u dumpable=%d native_caps=%s post_entry_exec=%s\n",
            (unsigned)getuid(), (unsigned)getgid(), dumpable,
            capability_failures ? "FAIL" : "EMPTY", exec_failures ? "NOT_CONFIRMED" : "DENIED");
    failures += bounded_namespace_observation_window();

    char executable[4096] = "unavailable", cwd[4096] = "unavailable";
    ssize_t executable_length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (executable_length < 0) failures += fail_errno("readlink-/proc/self/exe", errno);
    else if ((size_t)executable_length >= sizeof(executable) - 1)
        failures += fail_errno("readlink-/proc/self/exe", ENAMETOOLONG);
    else executable[executable_length] = '\0';
    struct stat executable_stat;
    memset(&executable_stat, 0, sizeof(executable_stat));
    if (stat("/proc/self/exe", &executable_stat) != 0) failures += fail_errno("stat-/proc/self/exe-inode", errno);
    else if (!executable_stat.st_ino) failures += fail_check("zero-/proc/self/exe-inode");
    if (!getcwd(cwd, sizeof(cwd))) failures += fail_errno("getcwd", errno);

    const char *namespace_names[] = {"mnt", "net", "pid", "user"};
    unsigned long long namespace_inodes[sizeof(namespace_names) / sizeof(namespace_names[0])] = {0};
    for (size_t i = 0; i < sizeof(namespace_names) / sizeof(namespace_names[0]); ++i) {
        char path[128]; struct stat st;
        snprintf(path, sizeof(path), "/proc/self/ns/%s", namespace_names[i]);
        if (stat(path, &st) != 0) { failures += fail_errno(path, errno); continue; }
        namespace_inodes[i] = (unsigned long long)st.st_ino;
        if (!namespace_inodes[i]) failures += fail_check(path);
    }

    size_t fd_count = 0;
    failures += observe_fdinfo(&fd_count);
    if (failures) {
        dprintf(STDERR_FILENO, "self-proc-visibility=FAIL failures=%d; no cross-process identity or channel proof\n", failures);
        return 1;
    }
    dprintf(STDOUT_FILENO,
            "self-proc-visibility=PASS scope=self-only exe=%s exe_inode=%llu cwd=%s "
            "ns_inodes=%llu,%llu,%llu,%llu fdinfo_entries=%zu; no cross-process identity or channel proof\n",
            executable, (unsigned long long)executable_stat.st_ino, cwd,
            namespace_inodes[0], namespace_inodes[1], namespace_inodes[2],
            namespace_inodes[3], fd_count);
    return 0;
}
