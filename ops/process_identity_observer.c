#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <linux/limits.h>
#include <linux/capability.h>
#include <sys/socket.h>

#ifndef __linux__
#error "process_identity_observer is Linux-only"
#endif

#define API_UNIT "fg-index-api.service"
#define HELPER_PATH "/usr/local/libexec/fg-index-deployment/process_identity_observer"
#define MAX_OUTPUT 4096
#define MAX_SYSTEMCTL 16384
#define MAX_FDS 4096

extern char **environ;

typedef struct {
    char active[32], sub[32], pid[32], control[32], restarts[32];
    char invocation[64], cgroup[PATH_MAX], profile[256];
} unit_snapshot;

typedef struct {
    pid_t pid;
    char starttime[32], cgroup[PATH_MAX], exe[PATH_MAX], cwd[PATH_MAX];
    char profile[256], caps[4][32];
    char inodes[MAX_FDS][32];
    size_t inode_count;
    int pidfd;
} process_snapshot;

typedef struct {
    char address[INET6_ADDRSTRLEN];
    char state[4], inode[32];
    unsigned port;
} listener_row;

static const char *cap_names[] = {"CapEff", "CapPrm", "CapBnd", "CapAmb"};
static char error_message[256];

static int fail(const char *message) {
    snprintf(error_message, sizeof(error_message), "%s", message);
    return -1;
}

static int valid_invocation(const char *s) {
    if (!s || strlen(s) != 32) return 0;
    for (size_t i = 0; i < 32; ++i)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return 0;
    return 1;
}

static int valid_environment(void) {
    int found_invocation = 0, found_exec_pid = 0, found_journal = 0;
    for (char **item = environ; item && *item; ++item) {
        if (!strncmp(*item, "INVOCATION_ID=", 14)) {
            if (found_invocation++ || !valid_invocation(*item + 14)) return 0;
        } else if (!strncmp(*item, "SYSTEMD_EXEC_PID=", 17)) {
            if (found_exec_pid++) return 0;
            const char *value = *item + 17;
            if (!*value) return 0;
            for (const char *p = value; *p; ++p) if (*p < '0' || *p > '9') return 0;
        } else if (!strncmp(*item, "JOURNAL_STREAM=", 15)) {
            if (found_journal++) return 0;
            const char *value = *item + 15; const char *colon = strchr(value, ':');
            if (!colon || colon == value || !colon[1]) return 0;
            for (const char *p = value; *p; ++p)
                if (p != colon && (*p < '0' || *p > '9')) return 0;
        } else {
            return 0;
        }
    }
    return found_invocation == 1;
}

static int environment_binds_to_self(void) {
    const char *value = getenv("SYSTEMD_EXEC_PID");
    if (!value) return 1;
    char *end = NULL; long pid = strtol(value, &end, 10);
    return end && !*end && pid == (long)getpid();
}

static int read_unit(unit_snapshot *out) {
    static const char *props[] = {"ActiveState", "SubState", "MainPID", "ControlPID",
        "NRestarts", "InvocationID", "ControlGroup", "AppArmorProfile"};
    int pipefd[2];
    if (pipe2(pipefd, O_CLOEXEC)) return fail("systemd query pipe failed");
    pid_t child = fork();
    if (child < 0) { close(pipefd[0]); close(pipefd[1]); return fail("systemd query fork failed"); }
    if (child == 0) {
        dup2(pipefd[1], STDOUT_FILENO);
        int nullfd = open("/dev/null", O_WRONLY | O_CLOEXEC);
        if (nullfd >= 0) dup2(nullfd, STDERR_FILENO);
        close(pipefd[0]); close(pipefd[1]);
        char *argv[16]; int n = 0;
        argv[n++] = "/usr/bin/systemctl"; argv[n++] = "show"; argv[n++] = "--all";
        for (size_t i = 0; i < sizeof(props) / sizeof(props[0]); ++i) {
            static char args[8][64];
            snprintf(args[i], sizeof(args[i]), "--property=%s", props[i]);
            argv[n++] = args[i];
        }
        argv[n++] = "--"; argv[n++] = API_UNIT; argv[n] = NULL;
        char *env[] = {"LANG=C", "LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", NULL};
        execve("/usr/bin/systemctl", argv, env);
        _exit(127);
    }
    close(pipefd[1]);
    char data[MAX_SYSTEMCTL + 1]; size_t used = 0;
    struct pollfd pfd = {.fd = pipefd[0], .events = POLLIN | POLLHUP};
    struct timespec start; clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
        struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
        long elapsed = (now.tv_sec - start.tv_sec) * 1000L + (now.tv_nsec - start.tv_nsec) / 1000000L;
        int remain = 5000 - (int)elapsed;
        if (remain <= 0 || poll(&pfd, 1, remain) <= 0) { kill(child, SIGKILL); waitpid(child, NULL, 0); close(pipefd[0]); return fail("systemd query timed out"); }
        ssize_t got = read(pipefd[0], data + used, sizeof(data) - used - 1);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) { kill(child, SIGKILL); waitpid(child, NULL, 0); close(pipefd[0]); return fail("systemd query read failed"); }
        if (got == 0) break;
        used += (size_t)got;
        if (used >= sizeof(data) - 1) { kill(child, SIGKILL); waitpid(child, NULL, 0); close(pipefd[0]); return fail("systemd query exceeded bound"); }
    }
    close(pipefd[0]); int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return fail("systemd query failed");
    data[used] = 0;
    char *save = NULL;
    for (char *line = strtok_r(data, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        char *eq = strchr(line, '='); if (!eq) return fail("malformed systemd property");
        *eq++ = 0; char *dest = NULL; size_t cap = 0;
        if (!strcmp(line, "ActiveState")) { dest = out->active; cap = sizeof(out->active); }
        else if (!strcmp(line, "SubState")) { dest = out->sub; cap = sizeof(out->sub); }
        else if (!strcmp(line, "MainPID")) { dest = out->pid; cap = sizeof(out->pid); }
        else if (!strcmp(line, "ControlPID")) { dest = out->control; cap = sizeof(out->control); }
        else if (!strcmp(line, "NRestarts")) { dest = out->restarts; cap = sizeof(out->restarts); }
        else if (!strcmp(line, "InvocationID")) { dest = out->invocation; cap = sizeof(out->invocation); }
        else if (!strcmp(line, "ControlGroup")) { dest = out->cgroup; cap = sizeof(out->cgroup); }
        else if (!strcmp(line, "AppArmorProfile")) { dest = out->profile; cap = sizeof(out->profile); }
        else return fail("unexpected systemd property");
        if (strlen(eq) >= cap || (dest[0] && strcmp(dest, eq))) return fail("duplicate or oversized systemd property");
        strcpy(dest, eq);
    }
    if (!out->active[0] || !out->sub[0] || !out->pid[0] || !out->control[0] || !out->restarts[0] ||
        !out->invocation[0] || !out->cgroup[0] || !out->profile[0]) return fail("systemd property is missing");
    if (strcmp(out->active, "active") || strcmp(out->control, "0") || strcmp(out->restarts, "0") ||
        !valid_invocation(out->invocation) || !*out->pid) return fail("API unit is not a stable active invocation");
    return 0;
}

static int read_file_at(int dirfd, const char *name, char *buffer, size_t size) {
    int fd = openat(dirfd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buffer, size - 1); int saved = errno; close(fd); errno = saved;
    if (n < 0 || (size_t)n >= size - 1) return -1;
    buffer[n] = 0; return 0;
}

static int process_starttime(int procfd, char *out, size_t size) {
    char raw[4096];
    if (read_file_at(procfd, "stat", raw, sizeof(raw))) return fail("process stat read failed");
    char *close = strrchr(raw, ')'); if (!close || close[1] != ' ') return fail("process stat is malformed");
    char *save = NULL; unsigned field = 3;
    for (char *token = strtok_r(close + 2, " ", &save); token; token = strtok_r(NULL, " ", &save), ++field) {
        if (field == 22) {
            if (!*token || strlen(token) >= size) return fail("process start time is malformed");
            for (char *p = token; *p; ++p) if (*p < '0' || *p > '9') return fail("process start time is malformed");
            strcpy(out, token); return 0;
        }
    }
    return fail("process start time is missing");
}

static int process_cgroup(int procfd, char *out, size_t size) {
    char raw[4096];
    if (read_file_at(procfd, "cgroup", raw, sizeof(raw))) return fail("process cgroup read failed");
    char *save = NULL; int found = 0;
    for (char *line = strtok_r(raw, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        if (!strncmp(line, "0::", 3)) {
            if (found++ || strlen(line + 3) >= size || strncmp(line + 3, "/system.slice/", 14)) return fail("process cgroup is invalid");
            strcpy(out, line + 3);
        }
    }
    return found == 1 ? 0 : fail("process cgroup is missing");
}

static int read_caps(int procfd, char caps[4][32]) {
    char raw[8192];
    if (read_file_at(procfd, "status", raw, sizeof(raw))) return fail("process status read failed");
    char *save = NULL;
    for (char *line = strtok_r(raw, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        for (size_t i = 0; i < 4; ++i) {
            size_t n = strlen(cap_names[i]);
            if (!strncmp(line, cap_names[i], n) && line[n] == ':') {
                char *value = line + n + 1; while (*value == ' ' || *value == '\t') ++value;
                size_t len = strcspn(value, " \t\r\n");
                if (!len || len >= sizeof(caps[i])) return fail("process capability field malformed");
                memcpy(caps[i], value, len); caps[i][len] = 0;
            }
        }
    }
    for (size_t i = 0; i < 4; ++i) if (!caps[i][0]) return fail("process capability field missing");
    return 0;
}

static int read_own_capabilities(char caps[4][32]) {
    struct __user_cap_header_struct header = {
        .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0
    };
    struct __user_cap_data_struct data[2] = {{0}};
#ifdef SYS_capget
    if (syscall(SYS_capget, &header, data) != 0) return fail("capget failed");
#else
    return fail("capget is unavailable");
#endif
    uint64_t effective = ((uint64_t)data[1].effective << 32) | data[0].effective;
    uint64_t permitted = ((uint64_t)data[1].permitted << 32) | data[0].permitted;
    uint64_t bounding = 0, ambient = 0;
    int bounding_ended = 0, ambient_ended = 0;
    for (int capability = 0; capability < 64; ++capability) {
        errno = 0;
        int value = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
        if (value == 1) bounding |= UINT64_C(1) << capability;
        else if (value < 0 && errno == EINVAL) bounding_ended = 1;
        else if (value < 0) return fail("bounding capability query failed");
        errno = 0;
        value = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0);
        if (value == 1) ambient |= UINT64_C(1) << capability;
        else if (value < 0 && errno == EINVAL) ambient_ended = 1;
        else if (value < 0) return fail("ambient capability query failed");
        if (bounding_ended && ambient_ended) break;
    }
    snprintf(caps[0], 32, "%016llx", (unsigned long long)effective);
    snprintf(caps[1], 32, "%016llx", (unsigned long long)permitted);
    snprintf(caps[2], 32, "%016llx", (unsigned long long)bounding);
    snprintf(caps[3], 32, "%016llx", (unsigned long long)ambient);
    return 0;
}

static int read_profile(int procfd, char *out, size_t size) {
    int attrfd = openat(procfd, "attr", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (attrfd < 0) return fail("process attribute directory unavailable");
    char raw[512]; int read_result = read_file_at(attrfd, "current", raw, sizeof(raw)); close(attrfd);
    if (read_result) return fail("process AppArmor label read failed");
    raw[strcspn(raw, "\r\n")] = 0;
    char *suffix = strstr(raw, " (enforce)");
    if (!suffix || suffix[10] != 0 || suffix == raw || (size_t)(suffix - raw) >= size) return fail("process AppArmor label is not enforcing");
    *suffix = 0; strcpy(out, raw); return 0;
}

static int fd_inodes(int procfd, process_snapshot *out) {
    int fd_dir = openat(procfd, "fd", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd_dir < 0) return fail("process FD directory unavailable");
    DIR *dir = fdopendir(dup(fd_dir)); if (!dir) { close(fd_dir); return fail("process FD directory unavailable"); }
    struct dirent *entry;
    while ((entry = readdir(dir))) {
        if (entry->d_name[0] == '.') continue;
        char target[256];
        ssize_t n = readlinkat(fd_dir, entry->d_name, target, sizeof(target) - 1);
        if (n < 0) { closedir(dir); close(fd_dir); return fail("process FD changed during inspection"); }
        target[n] = 0;
        if (!strncmp(target, "socket:[", 8)) {
            size_t len = strlen(target);
            if (len < 10 || target[len - 1] != ']' || out->inode_count >= MAX_FDS) { closedir(dir); close(fd_dir); return fail("socket inode malformed or over bound"); }
            target[len - 1] = 0; const char *inode = target + 8;
            for (const char *p = inode; *p; ++p) if (*p < '0' || *p > '9') { closedir(dir); close(fd_dir); return fail("socket inode malformed"); }
            int duplicate = 0; for (size_t i = 0; i < out->inode_count; ++i) if (!strcmp(out->inodes[i], inode)) duplicate = 1;
            if (!duplicate) { if (strlen(inode) >= sizeof(out->inodes[0])) { closedir(dir); close(fd_dir); return fail("socket inode too long"); } strcpy(out->inodes[out->inode_count++], inode); }
        }
    }
    closedir(dir); close(fd_dir);
    for (size_t i = 0; i < out->inode_count; ++i) for (size_t j = i + 1; j < out->inode_count; ++j)
        if (strcmp(out->inodes[i], out->inodes[j]) > 0) { char tmp[32]; strcpy(tmp, out->inodes[i]); strcpy(out->inodes[i], out->inodes[j]); strcpy(out->inodes[j], tmp); }
    return 0;
}

static int read_rows(int procfd, listener_row *rows, size_t *count) {
    int netfd = openat(procfd, "net", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (netfd < 0) return fail("API network namespace directory unavailable");
    const char *paths[] = {"tcp", "tcp6"}; int families[] = {AF_INET, AF_INET6};
    *count = 0;
    for (int table = 0; table < 2; ++table) {
        int tablefd = openat(netfd, paths[table], O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
        if (tablefd < 0) { if (table == 1 && errno == ENOENT) continue; close(netfd); return fail("kernel TCP table unavailable"); }
        FILE *f = fdopen(tablefd, "r"); if (!f) { close(tablefd); close(netfd); return fail("kernel TCP table unavailable"); }
        char *line = NULL; size_t cap = 0; if (getline(&line, &cap, f) < 0) { free(line); fclose(f); close(netfd); return fail("kernel TCP table malformed"); }
        while (getline(&line, &cap, f) >= 0) {
            unsigned sl, port; char local[80], remote[80], state[8], txq[32], timer[32], retr[32], uid[32], timeout[32], inode[32];
            int n = sscanf(line, " %u: %79s %79s %7s %31s %31s %31s %31s %31s %31s", &sl, local, remote, state, txq, timer, retr, uid, timeout, inode);
            if (n != 10 || strcmp(state, "0A")) continue;
            char *colon = strchr(local, ':'); if (!colon) { free(line); fclose(f); close(netfd); return fail("kernel TCP address malformed"); }
            *colon++ = 0; char *end = NULL; unsigned long parsed = strtoul(colon, &end, 16);
            if (!end || *end || parsed > 65535) { free(line); fclose(f); close(netfd); return fail("kernel TCP port malformed"); }
            port = (unsigned)parsed; if (port != 8080) continue;
            unsigned char addr[16]; size_t hexlen = strlen(local), needed = families[table] == AF_INET ? 8 : 32;
            if (hexlen != needed) { free(line); fclose(f); close(netfd); return fail("kernel TCP address width malformed"); }
            for (size_t i = 0; i < needed / 2; ++i) {
                char byte[3] = {local[i * 2], local[i * 2 + 1], 0}; addr[i] = (unsigned char)strtoul(byte, NULL, 16);
            }
            if (families[table] == AF_INET) { unsigned char b[4] = {addr[3], addr[2], addr[1], addr[0]}; memcpy(addr, b, 4); }
            else { for (size_t i = 0; i < 16; i += 4) { unsigned char a=addr[i], b=addr[i+1]; addr[i]=addr[i+3]; addr[i+1]=addr[i+2]; addr[i+2]=b; addr[i+3]=a; } }
            if (*count >= 128) { free(line); fclose(f); close(netfd); return fail("too many TCP listener rows"); }
            listener_row *row = &rows[(*count)++];
            if (!inet_ntop(families[table], addr, row->address, sizeof(row->address))) { free(line); fclose(f); close(netfd); return fail("TCP address conversion failed"); }
            strcpy(row->state, state); strcpy(row->inode, inode); row->port = port;
        }
        free(line); fclose(f);
    }
    close(netfd);
    return 0;
}

static int snapshot_process(pid_t pid, int procfd, int pinned_pidfd, process_snapshot *out) {
    memset(out, 0, sizeof(*out)); out->pid = pid; out->pidfd = dup(pinned_pidfd);
    if (out->pidfd < 0 || process_starttime(procfd, out->starttime, sizeof(out->starttime)) || process_cgroup(procfd, out->cgroup, sizeof(out->cgroup))) return fail("pinned process identity read failed");
    ssize_t n = readlinkat(procfd, "exe", out->exe, sizeof(out->exe)-1); if (n < 0 || (size_t)n >= sizeof(out->exe)-1) return fail("process executable read failed"); out->exe[n] = 0;
    n = readlinkat(procfd, "cwd", out->cwd, sizeof(out->cwd)-1); if (n < 0 || (size_t)n >= sizeof(out->cwd)-1) return fail("process CWD read failed"); out->cwd[n] = 0;
    if (read_caps(procfd, out->caps) || read_profile(procfd, out->profile, sizeof(out->profile)) || fd_inodes(procfd, out)) return -1;
    struct pollfd pfd = {.fd = out->pidfd, .events = POLLIN | POLLHUP | POLLERR};
    if (poll(&pfd, 1, 0) != 0) return fail("process exited during observation");
    return 0;
}

static int open_pinned_process(pid_t pid, int *pidfd_out, int *procfd_out) {
#ifdef SYS_pidfd_open
    int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (pidfd < 0) return fail("pidfd_open unavailable");
    struct pollfd pfd = {.fd = pidfd, .events = POLLIN | POLLHUP | POLLERR};
    if (poll(&pfd, 1, 0) != 0) { close(pidfd); return fail("API process exited before proc pin"); }
    int proc_root = open("/proc", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (proc_root < 0) { close(pidfd); return fail("proc root unavailable"); }
    char name[32]; snprintf(name, sizeof(name), "%ld", (long)pid);
    int procfd = openat(proc_root, name, O_PATH | O_DIRECTORY | O_CLOEXEC);
    close(proc_root);
    if (procfd < 0) { close(pidfd); return fail("API proc directory unavailable"); }
    if (poll(&pfd, 1, 0) != 0) { close(procfd); close(pidfd); return fail("API process exited while pinning proc directory"); }
    *pidfd_out = pidfd; *procfd_out = procfd; return 0;
#else
    (void)pid; (void)pidfd_out; (void)procfd_out;
    errno = ENOSYS; return fail("pidfd_open unavailable");
#endif
}

static int same_process(const process_snapshot *a, const process_snapshot *b) {
    if (a->pid != b->pid || strcmp(a->starttime,b->starttime) || strcmp(a->cgroup,b->cgroup) ||
        strcmp(a->exe,b->exe) || strcmp(a->cwd,b->cwd) || strcmp(a->profile,b->profile) ||
        memcmp(a->caps,b->caps,sizeof(a->caps)) || a->inode_count != b->inode_count) return 0;
    for (size_t i = 0; i < a->inode_count; ++i) if (strcmp(a->inodes[i],b->inodes[i])) return 0;
    struct pollfd pfd = {.fd = a->pidfd, .events = POLLIN | POLLHUP | POLLERR};
    return poll(&pfd, 1, 0) == 0;
}

static int same_rows(listener_row *a, size_t an, listener_row *b, size_t bn) {
    if (an != bn) return 0;
    for (size_t i = 0; i < an; ++i) if (strcmp(a[i].address,b[i].address) || strcmp(a[i].state,b[i].state) || strcmp(a[i].inode,b[i].inode) || a[i].port != b[i].port) return 0;
    return 1;
}

static void json_string(FILE *stream, const char *s) {
    fputc('"', stream); for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
        if (*p == '"' || *p == '\\') { fputc('\\', stream); fputc(*p, stream); }
        else if (*p < 0x20) fprintf(stream, "\\u%04x", *p); else fputc(*p, stream);
    } fputc('"', stream);
}

static void json_caps(FILE *stream, const char caps[4][32]) {
    fputc('{', stream); for (size_t i = 0; i < 4; ++i) { if (i) fputc(',', stream); json_string(stream, cap_names[i]); fputc(':', stream); json_string(stream, caps[i]); } fputc('}', stream);
}

static int run(void) {
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return fail("PR_SET_DUMPABLE failed");
    if (getpid() <= 1 || getuid() == 0 || geteuid() == 0) return fail("observer must run unprivileged");
    if (getenv("INVOCATION_ID") == NULL || !valid_environment()) return fail("observer environment is not manager-generated and fixed");
    char self_caps[4][32] = {{0}};
    if (read_own_capabilities(self_caps)) return -1;
    for (size_t i = 0; i < 4; ++i)
        if (strcmp(self_caps[i], "0000000000000000")) return fail("observer capabilities are not empty");
    /* argv validation is deliberately performed after the dumpability transition. */
    unit_snapshot before = {0}, after = {0};
    if (read_unit(&before)) return -1;
    char *end = NULL; long parsed = strtol(before.pid, &end, 10);
    if (!end || *end || parsed <= 1 || parsed > INT32_MAX) return fail("API PID is invalid");
    pid_t pid = (pid_t)parsed;
    if (strcmp(before.cgroup, "/system.slice/fg-index-api.service")) return fail("API cgroup differs from fixed unit");
    process_snapshot first = {.pidfd = -1}, second = {.pidfd = -1}; listener_row rows1[128], rows2[128]; size_t count1 = 0, count2 = 0;
    int api_pidfd = -1, procfd = -1;
    if (open_pinned_process(pid, &api_pidfd, &procfd)) return -1;
    if (snapshot_process(pid, procfd, api_pidfd, &first)) { close(procfd); close(api_pidfd); return -1; }
    if (strcmp(first.cgroup,before.cgroup) || read_rows(procfd,rows1,&count1)) { close(first.pidfd); close(procfd); close(api_pidfd); return fail("API process identity or TCP table mismatch"); }
    listener_row *listener = NULL;
    if (count1 == 1 && !strcmp(rows1[0].address,"127.0.0.1") && rows1[0].port == 8080 && !strcmp(rows1[0].state,"0A")) {
        for (size_t i = 0; i < first.inode_count; ++i) if (!strcmp(first.inodes[i],rows1[0].inode)) listener = &rows1[0];
        if (!listener) { close(first.pidfd); close(procfd); close(api_pidfd); return fail("API listener inode is not owned by its FD set"); }
    } else if (count1) { close(first.pidfd); close(procfd); close(api_pidfd); return fail("API TCP listener is ambiguous or unexpected"); }
    if (read_unit(&after) || memcmp(&before,&after,sizeof(before)) || snapshot_process(pid,procfd,api_pidfd,&second) || read_rows(procfd,rows2,&count2)) {
        if (first.pidfd >= 0) {
            close(first.pidfd);
        }
        if (second.pidfd >= 0) {
            close(second.pidfd);
        }
        close(procfd);
        close(api_pidfd);
        return fail("API identity changed during observation");
    }
    if (strcmp(first.cgroup,second.cgroup) || !same_process(&first,&second) || !same_rows(rows1,count1,rows2,count2)) {
        close(first.pidfd); close(second.pidfd); close(procfd); close(api_pidfd); return fail("API process changed during observation");
    }
    for (size_t i = 0; i < 4; ++i) if (strcmp(first.caps[i], "0000000000000000")) { close(first.pidfd); close(second.pidfd); close(procfd); close(api_pidfd); return fail("API capabilities are not empty"); }
    char invocation[64]; strcpy(invocation,getenv("INVOCATION_ID"));
    char *encoded = NULL; size_t encoded_length = 0;
    FILE *record = open_memstream(&encoded, &encoded_length);
    if (!record) { close(first.pidfd); close(second.pidfd); close(procfd); close(api_pidfd); return fail("observer output buffer unavailable"); }
    fputs("{\"schema\":\"fg-index.process-identity.helper.v1\",\"helper_invocation_id\":", record); json_string(record, invocation);
    fprintf(record, ",\"api_pid\":%ld,\"api_invocation_id\":", (long)pid); json_string(record, before.invocation);
    fputs(",\"api_control_group\":", record); json_string(record, first.cgroup); fputs(",\"api_starttime\":", record); json_string(record, first.starttime);
    fputs(",\"api_exe\":", record); json_string(record, first.exe); fputs(",\"api_cwd\":", record); json_string(record, first.cwd);
    fputs(",\"api_profile_label\":", record); json_string(record, first.profile); fputs(",\"api_capabilities\":", record); json_caps(record, first.caps);
    fputs(",\"api_fd_inodes\":[", record); for (size_t i = 0; i < first.inode_count; ++i) { if (i) fputc(',', record); json_string(record, first.inodes[i]); } fputs("],\"listener\":", record);
    if (listener) { fputs("{\"address\":\"127.0.0.1\",\"port\":8080,\"state\":\"0A\",\"inode\":", record); json_string(record, listener->inode); fputc('}', record); } else fputs("null", record);
    fputs(",\"pidfd_live\":true,\"helper_capabilities\":", record); json_caps(record, self_caps);
    fputs(",\"argv_ok\":true,\"caller_parameters_absent\":true}\n", record);
    if (fclose(record) || !encoded || encoded_length > MAX_OUTPUT) {
        free(encoded); close(first.pidfd); close(second.pidfd); close(procfd); close(api_pidfd); return fail("observer record exceeds its output bound");
    }
    size_t offset = 0;
    while (offset < encoded_length) {
        ssize_t written = write(STDOUT_FILENO, encoded + offset, encoded_length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) { free(encoded); close(first.pidfd); close(second.pidfd); close(procfd); close(api_pidfd); return fail("observer output write failed"); }
        offset += (size_t)written;
    }
    free(encoded);
    if (ferror(stdout)) { close(first.pidfd); close(second.pidfd); close(procfd); close(api_pidfd); return fail("observer output failed"); }
    char byte; ssize_t n; do { n = read(STDIN_FILENO,&byte,1); } while (n < 0 && errno == EINTR);
    struct pollfd original = {.fd = api_pidfd, .events = POLLIN | POLLHUP | POLLERR};
    int api_exited = poll(&original, 1, 0) != 0;
    unit_snapshot final_unit = {0};
    process_snapshot final = {.pidfd = -1};
    listener_row rows3[128]; size_t count3 = 0;
    int final_error = n != 0 || api_exited || read_unit(&final_unit) ||
        memcmp(&before, &final_unit, sizeof(before)) ||
        snapshot_process(pid, procfd, api_pidfd, &final) ||
        read_rows(procfd, rows3, &count3) ||
        !same_process(&first, &final) || !same_rows(rows1, count1, rows3, count3);
    if (final.pidfd >= 0) close(final.pidfd);
    close(first.pidfd); close(second.pidfd); close(procfd); close(api_pidfd);
    if (final_error) return fail("observer input, API liveness, or final identity fence failed");
    return 0;
}

int main(int argc, char **argv) {
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return 1;
    if (argc != 1 || !argv || !argv[0] || strcmp(argv[0], HELPER_PATH) ||
        !valid_environment() || !environment_binds_to_self()) return 1;
    if (run() == 0) return 0;
    return 1;
}
