import { z } from 'zod'

import { BACKLOG_HARVEST_RPC_UNITS } from '../../../../shared/backlog-harvest-report'

// The unit selects a fixed reader on this host; no path, id or glob is ever taken from the caller.
export const BacklogHarvestRunParams = z.object({ unit: z.enum(BACKLOG_HARVEST_RPC_UNITS) })
