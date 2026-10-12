#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Call libc directly so a language runtime cannot replace realpath with stat. */
static int probe(const char *operation, const char *path) {
  if (strcmp(operation, "realpath") == 0) {
    char *resolved = realpath(path, NULL);
    if (resolved == NULL) return -1;
    puts(resolved);
    free(resolved);
    return 0;
  }
  if (strcmp(operation, "stat") == 0) {
    struct stat metadata;
    if (stat(path, &metadata) != 0) return -1;
    puts("metadata");
    return 0;
  }
  if (strcmp(operation, "list") == 0) {
    DIR *directory = opendir(path);
    if (directory == NULL) return -1;
    errno = 0;
    (void)readdir(directory);
    int failure = errno;
    closedir(directory);
    if (failure != 0) {
      errno = failure;
      return -1;
    }
    puts("listed");
    return 0;
  }
  if (strcmp(operation, "read") == 0) {
    FILE *file = fopen(path, "r");
    if (file == NULL) return -1;
    int character;
    while ((character = fgetc(file)) != EOF) putchar(character);
    int failure = ferror(file);
    fclose(file);
    return failure ? -1 : 0;
  }
  if (strcmp(operation, "write") == 0) {
    int descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (descriptor < 0) return -1;
    close(descriptor);
    puts("writable");
    return 0;
  }
  errno = EINVAL;
  return -1;
}

int main(int argc, char **argv) {
  if (argc != 3) return 64;
  if (probe(argv[1], argv[2]) == 0) return 0;
  printf("errno=%d\n", errno);
  return 1;
}
