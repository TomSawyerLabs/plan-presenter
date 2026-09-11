/** [a, b, sign of compareVersions(a, b)]: shared by the skill and protocol tests. */
export const VERSION_VECTORS: Array<[string, string, -1 | 0 | 1]> = [
  ["0.1.0", "0.1.0", 0],
  ["0.2.0", "0.1.9", 1],
  ["0.10.0", "0.9.9", 1],
  ["1.0.0", "0.99.99", 1],
  ["1.0.0", "1.0.0-rc.1", 1],
  ["1.0.0-rc.2", "1.0.0-rc.10", -1],
  ["1.0.0-alpha", "1.0.0-alpha.1", -1],
  ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
  ["1.0.0-alpha.beta", "1.0.0-beta", -1],
  ["v1.2.3", "1.2.3", 0],
  ["1.2.3+build.5", "1.2.3", 0],
  ["dev", "0.0.1", -1],
  ["dev", "dev", 0],
];
