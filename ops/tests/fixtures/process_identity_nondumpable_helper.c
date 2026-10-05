#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static int read_caps(uint64_t *effective, uint64_t *permitted,
                     uint64_t *inheritable, uint64_t *bounding,
                     uint64_t *ambient) {
    struct __user_cap_header_struct header = {
        .version = _LINUX_CAPABILITY_VERSION_3,
        .pid = 0,
    };
    struct __user_cap_data_struct data[2] = {{0}};
#ifdef SYS_capget
    if (syscall(SYS_capget, &header, data) != 0) {
        return -1;
    }
#else
    errno = ENOSYS;
    return -1;
#endif

    *effective = ((uint64_t)data[1].effective << 32) | data[0].effective;
    *permitted = ((uint64_t)data[1].permitted << 32) | data[0].permitted;
    *inheritable = ((uint64_t)data[1].inheritable << 32) | data[0].inheritable;
    *bounding = 0;
    *ambient = 0;
    int bounding_done = 0;
    int ambient_done = 0;

    for (int capability = 0; capability < 64; ++capability) {
        if (!bounding_done) {
            errno = 0;
            int value = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
            if (value == 1) {
                *bounding |= UINT64_C(1) << capability;
            } else if (value < 0 && errno == EINVAL) {
                bounding_done = 1;
            } else if (value < 0) {
                return -1;
            }
        }
        if (!ambient_done) {
            errno = 0;
            int value = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET,
                              capability, 0, 0);
            if (value == 1) {
                *ambient |= UINT64_C(1) << capability;
            } else if (value < 0 && errno == EINVAL) {
                ambient_done = 1;
            } else if (value < 0) {
                return -1;
            }
        }
        if (bounding_done && ambient_done) {
            break;
        }
    }
    return 0;
}

int main(void) {
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
        return 90;
    }

    uint64_t effective, permitted, inheritable, bounding, ambient;
    if (read_caps(&effective, &permitted, &inheritable, &bounding, &ambient) != 0) {
        return 91;
    }

    int attr_fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC);
    if (attr_fd < 0) {
        return 92;
    }
    char profile[256];
    ssize_t profile_size = read(attr_fd, profile, sizeof(profile) - 1);
    close(attr_fd);
    if (profile_size <= 0 || profile_size >= (ssize_t)(sizeof(profile) - 1)) {
        return 93;
    }
    profile[profile_size] = '\0';
    while (profile_size > 0 &&
           (profile[profile_size - 1] == '\n' || profile[profile_size - 1] == '\r')) {
        profile[--profile_size] = '\0';
    }

    int ns_fd = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
    if (ns_fd < 0) {
        return 94;
    }
    if (dprintf(STDOUT_FILENO,
                "%ld %u %u %d %016llx %016llx %016llx %016llx %016llx %s\n",
                (long)getpid(), (unsigned)getuid(), (unsigned)getgid(), ns_fd,
                (unsigned long long)effective, (unsigned long long)permitted,
                (unsigned long long)inheritable, (unsigned long long)bounding,
                (unsigned long long)ambient, profile) < 0) {
        return 95;
    }

    for (;;) {
        pause();
    }
}
