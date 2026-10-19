export interface FirmwareVersion {
  version: string;
  buildId: string;
  parentVersion: string | null;
  mergedInto?: string;
  branchName: string;
  committedAt: Date;
  author: string;
  changelog: string;
  elfStored: boolean;
  deviceCount: number;
  size: number;
  tag?: 'latest' | 'stable';
  // nff-ota artifact integrity (present once a deployable binary has been uploaded)
  checksumSha256?: string | null;
  signature?: string | null;
  storagePath?: string | null;
  deviceTypes?: string[];
}

const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

// Ordered newest-first — this is the display order used by the Releases (OTA) view
export const mockFirmwareVersions: FirmwareVersion[] = [
  {
    version: '3.0.0',
    buildId: 'f0a1b2c3',
    parentVersion: '2.4.1',
    branchName: 'main',
    committedAt: daysAgo(2),
    author: 'GLechevalier',
    changelog:
      'Major: migrated to ESP-IDF v5.2\n' +
      'Added nff-sdk-c v1 integration (MQTT management channel, heartbeat, OTA)\n' +
      'Added FreeRTOS dual-core AMP task layout\n' +
      'New power manager: dynamic freq scaling 80/160/240 MHz\n' +
      'Removed legacy ArduinoOTA in favour of nff OTA pipeline\n' +
      'Bump mbedTLS to 3.5.0',
    elfStored: true,
    deviceCount: 1,
    size: 1_389_412,
    tag: 'latest',
  },
  {
    version: '2.4.1',
    buildId: 'c8d3e4f5',
    parentVersion: '2.4.0',
    branchName: 'main',
    committedAt: daysAgo(5),
    author: 'GLechevalier',
    changelog:
      'Fix: RSSI reporting off-by-one in WiFi scan result parsing\n' +
      'Fix: NTP sync fails on cold boot if DHCP takes >3s\n' +
      'Fix: telemetry timestamp uses local time instead of UTC\n' +
      'Improvement: reduce MQTT reconnect backoff max from 60s to 30s',
    elfStored: true,
    deviceCount: 4,
    size: 1_245_056,
    tag: 'stable',
  },
  {
    version: '2.4.0',
    buildId: 'a3f9b2c1',
    parentVersion: '2.3.8',
    branchName: 'main',
    committedAt: daysAgo(8),
    author: 'GLechevalier',
    changelog:
      'Major: sensor driver rewrite — async I2C polling replaces blocking reads\n' +
      'New: sensor_poll() coroutine dispatch (introduces recursion depth regression — patched in v2.4.1)\n' +
      'Merge: hotfix/heap-fix (v2.3.9) — QoS-1 MQTT buffer leak fix\n' +
      'Fix: DHT22 read sometimes returns stale data after WiFi reconnect',
    elfStored: true,
    deviceCount: 1,
    size: 1_241_984,
  },
  {
    version: '2.3.9',
    buildId: 'e5f6a7b8',
    parentVersion: '2.3.8',
    mergedInto: '2.4.0',
    branchName: 'hotfix/heap-fix',
    committedAt: daysAgo(9),
    author: 'GLechevalier',
    changelog:
      'Hotfix: QoS-1 outbound buffer not freed on ACK timeout\n' +
      'Leak rate was ~17.5 bytes/s, causing OOM after ~10 days uptime\n' +
      'Fix in mqtt_client.cpp:214 — call mqtt_buf_free() in ACK timeout handler',
    elfStored: true,
    deviceCount: 0,
    size: 1_198_592,
  },
  {
    version: '2.3.8',
    buildId: 'b7c2d3e4',
    parentVersion: '2.2.0',
    branchName: 'main',
    committedAt: daysAgo(14),
    author: 'GLechevalier',
    changelog:
      'New: calibration register read/write API for DHT22 and BME280\n' +
      'Fix: WiFi reconnect does not re-register mDNS hostname\n' +
      'Fix: uptime counter wraps at 49 days (uint32 overflow)\n' +
      'Improvement: heap profiler now reports allocation site per task',
    elfStored: true,
    deviceCount: 1,
    size: 1_196_032,
  },
  {
    version: '2.2.0',
    buildId: 'd9e4f5a6',
    parentVersion: '1.9.3',
    branchName: 'main',
    committedAt: daysAgo(30),
    author: 'GLechevalier',
    changelog:
      'New: DHCP lease renewal monitoring with auto-reconnect on expiry\n' +
      'New: configurable DHCP lease time pushed via nff set-config\n' +
      'Fix: relay state not persisted across reboot (NVS write missing)\n' +
      'Removed: legacy serial command interface replaced by MQTT cmd topic',
    elfStored: false,
    deviceCount: 1,
    size: 1_089_536,
  },
  {
    version: '1.9.3',
    buildId: 'a1b2c3d4',
    parentVersion: '1.5.2',
    branchName: 'main',
    committedAt: daysAgo(60),
    author: 'GLechevalier',
    changelog:
      'New: LoRa bridge support (SX1276 driver)\n' +
      'Fix: LoRa packet fragmentation at MTU boundary\n' +
      'Fix: RTC memory log not cleared on factory reset\n' +
      'Improvement: exponential backoff for MQTT reconnect',
    elfStored: false,
    deviceCount: 1,
    size: 987_136,
  },
  {
    version: '1.5.2',
    buildId: '00000001',
    parentVersion: null,
    branchName: 'main',
    committedAt: daysAgo(120),
    author: 'GLechevalier',
    changelog:
      'Initial stable release\n' +
      'Basic WiFi + MQTT connectivity\n' +
      'DHT22 temperature/humidity sensor\n' +
      'Serial command interface',
    elfStored: false,
    deviceCount: 1,
    size: 891_904,
  },
];
