// Node-environment tests. Anything that needs a real cross-origin isolated
// page — SharedArrayBuffer, the ring, the AudioWorklet — gets browser mode
// with the client (ADR-0014).
export default {
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
}
