-- Argo CD health check for Crossplane objects (XRs such as platform.asterius.io/Service, managed resources,
-- packages, XRDs, Compositions). install.sh registers it in argocd-cm `resource.customizations` for
-- platform.asterius.io/*, *.upbound.io/* and *.crossplane.io/* (wildcards are only valid in that block form:
-- ConfigMap keys cannot hold `*`).
local hs = { status = "Progressing", message = "Waiting for status" }
local ann = (obj.metadata and obj.metadata.annotations) or {}
if ann["crossplane.io/paused"] == "true" then
  hs.status = "Suspended"
  hs.message = "Reconciliation paused"
  return hs
end
-- Objects without conditions (Composition, ProviderConfig, DeploymentRuntimeConfig...) are healthy once applied.
local noStatus = { Composition = true, CompositionRevision = true, ProviderConfig = true,
  ClusterProviderConfig = true, ProviderConfigUsage = true, ClusterProviderConfigUsage = true,
  DeploymentRuntimeConfig = true, EnvironmentConfig = true, ImageConfig = true, ControllerConfig = true,
  StoreConfig = true, Usage = true, ClusterUsage = true }
if obj.status == nil or obj.status.conditions == nil or #obj.status.conditions == 0 then
  if noStatus[obj.kind] then
    hs.status = "Healthy"
    hs.message = "Applied"
  end
  return hs
end
local c = {}
for _, cond in ipairs(obj.status.conditions) do c[cond.type] = cond end
local function msg(cond) return cond.message or cond.reason or cond.type end
-- Reconcile errors: the provider or Crossplane could not apply the desired state.
for _, t in ipairs({ "Synced", "LastAsyncOperation" }) do
  if c[t] ~= nil and c[t].status == "False" then
    hs.status = "Degraded"
    hs.message = t .. ": " .. msg(c[t])
    return hs
  end
end
if c["Ready"] ~= nil then
  if c["Ready"].status == "True" then
    hs.status = "Healthy"
    hs.message = "Ready"
  else
    hs.message = "Ready: " .. msg(c["Ready"])
  end
  return hs
end
-- CompositeResourceDefinition
if c["Established"] ~= nil then
  if c["Established"].status == "True" and (c["Offered"] == nil or c["Offered"].status == "True") then
    hs.status = "Healthy"
    hs.message = "Established"
  else
    hs.message = "Established: " .. msg(c["Established"])
  end
  return hs
end
-- Provider / Function / Configuration packages
if c["Installed"] ~= nil then
  if c["Installed"].status == "True" and c["Healthy"] ~= nil and c["Healthy"].status == "True" then
    hs.status = "Healthy"
    hs.message = "Installed and healthy"
  elseif c["Healthy"] ~= nil then
    hs.message = "Healthy: " .. msg(c["Healthy"])
  else
    hs.message = "Installed: " .. msg(c["Installed"])
  end
  return hs
end
if c["Synced"] ~= nil and c["Synced"].status == "True" then
  hs.status = "Healthy"
  hs.message = "Synced"
end
return hs
