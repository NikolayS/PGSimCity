#!/usr/bin/env node

import { reapStaleProfiles } from './cdp-profile.mjs'

const removed = reapStaleProfiles()
console.log(`reaped ${removed.length} Chrome profile${removed.length === 1 ? '' : 's'}`)
