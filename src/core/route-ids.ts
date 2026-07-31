/* Route IDs are a cross-layer event contract. Geometry remains owned by
 * world/layout.ts; producers can name a route without importing the world. */
export const rid = {
  fork: (i: number) => `fork.${i}`,
  query: (i: number) => `query.${i}`,
  result: (i: number) => `result.${i}`,
  bufReq: (i: number) => `buf.req.${i}`,
  bufRet: (i: number) => `buf.ret.${i}`,
  walIns: (i: number) => `wal.ins.${i}`,
  lockWait: (i: number) => `lock.wait.${i}`,
  ioRead: (t: number) => `io.read.${t}`,
  ioReadCache: (t: number) => `io.read.cache.${t}`,
  ioWrite: (t: number) => `io.write.${t}`,
  vacGo: (t: number) => `vac.go.${t}`,
  vacBack: (t: number) => `vac.back.${t}`,
  vacIdx: (t: number) => `vac.idx.${t}`,
  fsmReturn: (t: number) => `fsm.return.${t}`,
  idxLookup: (t: number) => `idx.lookup.${t}`,
} as const
