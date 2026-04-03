// @ts-check
/** @type {import('../../testcases').Meta} */
export default {
  options: {},
  rollupOptions: {
    input: ["entry-a.d.ts", "entry-b.d.ts"],
    output: {
      entryFileNames: "[name].d.mts",
      chunkFileNames: "[name]-[hash].d.mts",
    },
  },
};
