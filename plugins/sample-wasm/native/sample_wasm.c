// Build with a WASI-capable clang:
// clang --target=wasm32-wasi -O2 -Wl,--no-entry -Wl,--export=overlord_alloc \
//   -Wl,--export=overlord_free -Wl,--export=overlord_on_load \
//   -Wl,--export=overlord_on_event -Wl,--export=overlord_on_unload \
//   -o sample-wasm.wasm sample_wasm.c

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

__attribute__((import_module("env"), import_name("overlord_emit")))
extern int32_t overlord_emit(const char *event, int32_t event_len, const char *payload, int32_t payload_len);

__attribute__((import_module("env"), import_name("overlord_host_info")))
extern int32_t overlord_host_info(uint8_t *out, int32_t out_len);

__attribute__((import_module("env"), import_name("overlord_fs_mkdir")))
extern int32_t overlord_fs_mkdir(const char *bucket, int32_t bucket_len, const char *path, int32_t path_len);

__attribute__((import_module("env"), import_name("overlord_fs_write")))
extern int32_t overlord_fs_write(const char *bucket, int32_t bucket_len, const char *path, int32_t path_len, const uint8_t *data, int32_t data_len);

__attribute__((import_module("env"), import_name("overlord_fs_list")))
extern int32_t overlord_fs_list(const char *bucket, int32_t bucket_len, const char *path, int32_t path_len, uint8_t *out, int32_t out_len);

void *overlord_alloc(uint32_t size) {
  return malloc(size ? size : 1);
}

void overlord_free(void *ptr, uint32_t size) {
  (void)size;
  free(ptr);
}

int32_t overlord_on_load(const char *host_info, int32_t host_info_len) {
  const char *event = "ready";
  overlord_emit(event, 5, host_info, host_info_len);
  return 0;
}

int32_t overlord_on_event(const char *event, int32_t event_len, const char *payload, int32_t payload_len) {
  (void)payload;
  (void)payload_len;
  if (event_len != 10 || memcmp(event, "run_sample", 10) != 0) return 0;

  const char *plugin_data = "pluginData";
  const char *downloads = "downloads";
  const char *dir = "notes";
  const char *file = "notes/sample.txt";
  const char *note = "sample wasm plugin wrote this file\n";

  int32_t mkdir_result = overlord_fs_mkdir(plugin_data, 10, dir, 5);
  int32_t write_result = overlord_fs_write(plugin_data, 10, file, 16, (const uint8_t *)note, (int32_t)strlen(note));

  uint8_t list_buf[4096];
  int32_t list_result = overlord_fs_list(downloads, 9, "", 0, list_buf, sizeof(list_buf));
  uint8_t host_buf[1024];
  int32_t host_result = overlord_host_info(host_buf, sizeof(host_buf));

  char response[256];
  int n = snprintf(response, sizeof(response),
    "{\"mkdir\":%d,\"write\":%d,\"downloadsListBytes\":%d,\"hostInfoBytes\":%d}",
    mkdir_result, write_result, list_result, host_result);
  overlord_emit("sample_result", 13, response, n);
  return 0;
}

void overlord_on_unload(void) {}
