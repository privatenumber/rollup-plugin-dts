// entry-a.d.cts
declare class Shared {
  value: string;
}
declare const a: Shared;
export { Shared, a };
// entry-b.d.cts
import { Shared } from './entry-a.cjs';
declare const b: Shared;
export { Shared, b };
