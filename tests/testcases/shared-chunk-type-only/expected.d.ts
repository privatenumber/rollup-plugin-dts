// entry-a.d.ts
interface Config {
  name: string;
  value: number;
}
type ConfigKey = keyof Config;
declare function getConfig(): Config;
declare function getKey(): ConfigKey;
export { Config, ConfigKey, getConfig, getKey };
// entry-b.d.ts
import { Config, ConfigKey } from './entry-a.js';
declare function setConfig(c: Config, k: ConfigKey): void;
export { Config, ConfigKey, setConfig };
