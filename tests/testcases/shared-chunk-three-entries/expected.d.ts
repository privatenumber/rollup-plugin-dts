// entry-a.d.ts
declare class Shared {
  value: string;
}
declare const a: Shared;
export { Shared, a };
// entry-b.d.ts
import { Shared } from './entry-a.js';
declare const b: Shared;
export { Shared, b };
// entry-c.d.ts
import { Shared } from './entry-a.js';
declare const c: Shared;
export { Shared, c };
