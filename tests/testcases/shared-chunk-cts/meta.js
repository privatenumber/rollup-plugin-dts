// @ts-check
/** @type {import('../../testcases').Meta} */
export default {
  options: {},
  rollupOptions: {
    input: ["entry-a.d.ts", "entry-b.d.ts"],
    output: {
      entryFileNames: "[name].d.cts",
      chunkFileNames: "[name]-[hash].d.cts",
    },
  },
};
