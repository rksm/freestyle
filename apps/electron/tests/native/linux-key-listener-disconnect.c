#include <assert.h>
#include <dirent.h>
#include <poll.h>
#include <sys/ioctl.h>

static DIR *test_opendir(const char *path);
static int test_ioctl(int fd, unsigned long request, void *bits);
static int test_poll(struct pollfd *fds, nfds_t count, int timeout);

#define opendir test_opendir
#define ioctl test_ioctl
#define poll test_poll
#define main listener_main
#include "../../native/linux-key-listener.c"
#undef opendir
#undef ioctl
#undef poll
#undef main

static DIR *test_opendir(const char *path) {
    assert(strcmp(path, "/dev/input") == 0);
    return opendir(getenv("TEST_INPUT_DIR"));
}

/* Use ordinary files as input devices without requiring input-group access. */
static int test_ioctl(int fd, unsigned long request, void *bits) {
    (void)fd;
    (void)request;
    *(unsigned long *)bits = 1UL << EV_KEY;
    return 0;
}

static int test_poll(struct pollfd *fds, nfds_t count, int timeout) {
    static int calls = 0;
    static int disconnected_fd;
    assert(count == 3);
    assert(timeout == 1000);
    for (nfds_t i = 0; i < count; i++) fds[i].revents = 0;
    if (calls++ == 0) {
        disconnected_fd = fds[0].fd;
        g_ctrlDown = g_altDown = g_shiftDown = g_metaDown = 1;
        g_isKeyDown = !g_record_mode;
        fds[0].revents = atoi(getenv("TEST_POLL_FLAGS"));
    } else {
        /* The next wait must exclude the dead device and retain the other one. */
        assert(fds[0].fd == -1);
        assert(fcntl(disconnected_fd, F_GETFD) == -1 && errno == EBADF);
        assert(fcntl(fds[1].fd, F_GETFD) >= 0);
        assert(!g_ctrlDown && !g_altDown && !g_shiftDown && !g_metaDown);
        assert(!g_isKeyDown);
        fds[2].revents = POLLHUP;
    }
    return 1;
}

int main(int argc, char **argv) {
    return listener_main(argc, argv);
}
