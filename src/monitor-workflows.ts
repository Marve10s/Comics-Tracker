const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

export interface MonitorWorkflow {
  file: string
  label: string
  envFlag?: string
}

const ALL_MONITOR_WORKFLOWS: MonitorWorkflow[] = [
  { file: "monitor-instocktrades.yml", label: "InStockTrades" },
  { file: "monitor-ebay.yml", label: "eBay", envFlag: "ENABLE_EBAY" },
]

function isEnvFlagEnabled(flagName: string): boolean {
  const raw = process.env[flagName]?.trim().toLowerCase()
  return raw ? TRUE_VALUES.has(raw) : false
}

export function getEnabledMonitorWorkflows(): MonitorWorkflow[] {
  return ALL_MONITOR_WORKFLOWS.filter((workflow) =>
    workflow.envFlag ? isEnvFlagEnabled(workflow.envFlag) : true,
  )
}
