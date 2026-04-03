export interface Config {
  name: string;
  value: number;
}
export type ConfigKey = keyof Config;
