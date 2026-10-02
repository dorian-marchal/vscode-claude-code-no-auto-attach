// Built by extension.js (ensureMicHelper) on first activation; see onMicStart there.
#include <CoreAudio/CoreAudio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static AudioObjectPropertyAddress address(AudioObjectPropertySelector selector, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress result = { selector, scope, kAudioObjectPropertyElementMain };
  return result;
}

static AudioDeviceID default_input(void) {
  AudioObjectPropertyAddress where = address(kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal);
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &where, 0, NULL, &size, &device);
  return device;
}

// The new default can take a few ms to be visible; wait for it so the recorder opens it.
static int set_default_input(AudioDeviceID device) {
  AudioObjectPropertyAddress where = address(kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal);
  if (AudioObjectSetPropertyData(kAudioObjectSystemObject, &where, 0, NULL, sizeof(device), &device) != noErr) return 0;
  for (int i = 0; i < 40 && default_input() != device; i++) usleep(5000);
  return default_input() == device;
}

// The headset jack is a built-in device too ("External Microphone"): only the internal mic
// has the 'imic' input data source.
static int is_internal_mic(AudioDeviceID device) {
  AudioObjectPropertyAddress where = address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeInput);
  UInt32 source = 0, size = sizeof(source);
  return AudioObjectGetPropertyData(device, &where, 0, NULL, &size, &source) == noErr && source == 'imic';
}

static AudioDeviceID builtin_input(void) {
  AudioObjectPropertyAddress where = address(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &where, 0, NULL, &size) != noErr) return kAudioObjectUnknown;
  AudioDeviceID *devices = malloc(size);
  AudioDeviceID found = kAudioObjectUnknown;
  if (devices && AudioObjectGetPropertyData(kAudioObjectSystemObject, &where, 0, NULL, &size, devices) == noErr) {
    for (UInt32 i = 0; i < size / sizeof(AudioDeviceID) && found == kAudioObjectUnknown; i++) {
      AudioObjectPropertyAddress transportWhere = address(kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal);
      UInt32 transport = 0, transportSize = sizeof(transport);
      if (AudioObjectGetPropertyData(devices[i], &transportWhere, 0, NULL, &transportSize, &transport) == noErr &&
          transport == kAudioDeviceTransportTypeBuiltIn && is_internal_mic(devices[i])) {
        found = devices[i];
      }
    }
  }
  free(devices);
  return found;
}

static void append_device(char *line, size_t room, AudioDeviceID device) {
  AudioObjectPropertyAddress where = address(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
  CFStringRef name = NULL;
  UInt32 size = sizeof(name);
  char text[256] = "?";
  if (AudioObjectGetPropertyData(device, &where, 0, NULL, &size, &name) == noErr && name) {
    CFStringGetCString(name, text, sizeof(text), kCFStringEncodingUTF8);
    CFRelease(name);
  }
  size_t used = strlen(line);
  snprintf(line + used, room - used, "%s%u %s", used ? "\t" : "", (unsigned)device, text);
}

// The input devices <pid> records from, as "<id> <name>" separated by tabs (macOS 14.4+).
// Empty while the process has not opened any input yet.
static void process_inputs(pid_t pid, char *line, size_t room) {
  line[0] = 0;
  AudioObjectPropertyAddress where = address(kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal);
  AudioObjectID process = kAudioObjectUnknown;
  UInt32 size = sizeof(process);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &where, sizeof(pid), &pid, &size, &process) != noErr) return;
  if (process == kAudioObjectUnknown) return;
  AudioObjectPropertyAddress devicesWhere = address(kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput);
  if (AudioObjectGetPropertyDataSize(process, &devicesWhere, 0, NULL, &size) != noErr || size == 0) return;
  AudioDeviceID *devices = malloc(size);
  if (devices && AudioObjectGetPropertyData(process, &devicesWhere, 0, NULL, &size, devices) == noErr) {
    for (UInt32 i = 0; i < size / sizeof(AudioDeviceID); i++) append_device(line, room, devices[i]);
  }
  free(devices);
}

// Started before the recorder, so starting CoreAudio here costs nothing: print the first
// input list <pid> records from as soon as it has one, checking every 10ms for 4s at most.
static int watch_inputs(pid_t pid) {
  char line[4096];
  for (int i = 0; i < 400; i++) {
    process_inputs(pid, line, sizeof(line));
    if (line[0]) {
      printf("%s\n", line);
      return 0;
    }
    usleep(10000);
  }
  fprintf(stderr, "the recorder opened no input within 4s\n");
  return 1;
}

// `builtin`: make the built-in mic the default input, print "<previous> <builtin>".
// `restore <previous> <builtin>`: put <previous> back, unless the default changed since.
// `watch <pid>`: wait until <pid> records, then print the input devices it reads.
int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "watch") == 0) return watch_inputs((pid_t)atoi(argv[2]));
  if (argc == 2 && strcmp(argv[1], "builtin") == 0) {
    AudioDeviceID builtin = builtin_input(), previous = default_input();
    if (builtin == kAudioObjectUnknown) {
      fprintf(stderr, "no built-in input device\n");
      return 1;
    }
    if (previous != builtin && !set_default_input(builtin)) {
      fprintf(stderr, "could not make the built-in mic the default input\n");
      return 1;
    }
    printf("%u %u\n", (unsigned)previous, (unsigned)builtin);
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "restore") == 0) {
    AudioDeviceID previous = (AudioDeviceID)strtoul(argv[2], NULL, 10);
    AudioDeviceID builtin = (AudioDeviceID)strtoul(argv[3], NULL, 10);
    if (default_input() != builtin) return 0;
    if (!set_default_input(previous)) {
      fprintf(stderr, "could not restore the default input\n");
      return 1;
    }
    return 0;
  }
  fprintf(stderr, "usage: %s builtin | restore <previous> <builtin> | watch <pid>\n", argv[0]);
  return 2;
}
