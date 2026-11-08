import solid from "vite-plugin-solid"

export const shared = {
  plugins: [solid()],
  resolve: {
    alias: [
      { find: /^solid-js\/web$/, replacement: "solid-js/web/dist/dev.js" },
      { find: /^solid-js$/, replacement: "solid-js/dist/dev.js" },
    ],
  },
  test: {
    server: { deps: { inline: [/solid-js/] } },
  },
}
