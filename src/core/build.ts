declare const __PGSIMCITY_VERSION__: string
declare const __PGSIMCITY_GIT_SHA__: string

export const BUILD_VERSION =
  typeof __PGSIMCITY_VERSION__ === 'string' ? __PGSIMCITY_VERSION__ : 'dev'
export const BUILD_SHA =
  typeof __PGSIMCITY_GIT_SHA__ === 'string' ? __PGSIMCITY_GIT_SHA__ : 'unknown'
export const BUILD_LABEL = `v${BUILD_VERSION} · ${BUILD_SHA}`
