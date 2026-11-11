# Azure DevOps self-service: setup and A-to-Z test

The default configuration ([config/azure-devops.yaml](../../config/azure-devops.yaml)) offers these workflows:

| Where | Workflow | Steps |
|---|---|---|
| Self-service page | **Create an Azure DevOps project** | pipeline `create-project` → register `ado-project` |
| ⋯ on a project | **Add a member** | approval (Project Administrators only) → pipeline `add-member` → register `ado-member` |
| ⋯ on a project | **Add a repository** | pipeline `create-repository` → register `ado-repository` |
| ⋯ on a project | **Delete project** | approval before start → pipeline `delete-project` → unregister the project, its members and repositories |
| ⋯ on a member | **Remove member** | pipeline `remove-member` → unregister |
| ⋯ on a repository | **Delete repository** | pipeline `delete-repository` → unregister |

All of them queue the same pipeline, [platform-ado.yml](platform-ado.yml), with an `operation` template parameter. The pipeline uses the `az devops` CLI. Each operation is idempotent: it does nothing when the project, repository or membership already exists (or is already gone), so a failed run can simply be run again.

## 1. Two personal access tokens

Create them in Azure DevOps → User settings → Personal access tokens. You may use one token for both while testing.

| Token | Used by | Scopes |
|---|---|---|
| `ADO_PAT` | the platform, to queue and follow the pipeline | Build: *Read & execute* |
| `ADO_ADMIN_PAT` | the pipeline, to change the organization | Project and Team: *Read, write & manage* · Code: *Full* · Graph: *Read & manage* · Member Entitlement Management: *Read & write* · Identity: *Read* |

The owner of `ADO_ADMIN_PAT` must be allowed to create projects: a Project Collection Administrator, or a member of a group with "Create new projects" permission.

## 2. The pipeline

1. In an existing project, for example `Platform`, create a Git repository (e.g. `platform-automation`) and push `platform-ado.yml` to it.
2. Pipelines → New pipeline → Azure Repos Git → that repository → *Existing Azure Pipelines YAML file* → `/platform-ado.yml` → **Save** (don't run it).
3. Edit the pipeline → Variables → add `ADO_ADMIN_PAT` and tick **Keep this value secret**.
4. Note the pipeline id: the number after `definitionId=` in the pipeline's URL.

The first run may ask to "permit" access to the agent pool. Open it once in Azure DevOps if a run stays queued.

## 3. The platform

1. In [config/azure-devops.yaml](../../config/azure-devops.yaml), edit the `azure-devops` connection at the top
   (the workflows take the organization URL, the project and the token from it):
   - `fields.organization`: `<your-org>` (the part after `https://dev.azure.com/`)
   - `fields.project`: the project holding the pipeline
   - and, in each workflow's pipeline step, `pipelineId` and `branch`
2. Start the platform (`npm run dev`). For a clean test (the default `./data` still holds the old demo catalog), use a new data directory: `DATA_DIR=$PWD/data-ado npm run dev`.
3. Sign up; the first account is an admin.
4. Admin → Users: add yourself to the **Platform** team. The create form asks for an owning team, and approvals go to Platform.
5. Admin → Secrets: add `ADO_PAT`. Admin → Connections → *Azure DevOps (AsteriusIT)* → **Test connection** lists the
   organization's projects, so it also needs the PAT scope "Project and Team (Read)"; the workflows only need
   "Build (Read & execute)".

## 4. A-to-Z test

1. **Self-service → Create an Azure DevOps project**. Enter a name without spaces (`Demo-App`), the team Platform and a description, then submit.
   - The run page shows the pipeline step with a link to the Azure DevOps run. Status is polled every `RUN_POLL_SECONDS` (15 s by default).
   - Creating a project takes about 30 s to 1 min. The project then appears under Catalog → Azure DevOps project.
2. On the project (catalog row **⋯** or the entity page):
   - **Add a member** as Contributors: added directly. Someone outside the organization is added with Basic access.
   - **Add a member** as Project Administrators: the run waits on the *Platform approval* step. Approve it from the header icon or the run page; the test config allows approving your own request.
   - **Add a repository** `api`: it appears under Azure DevOps repository with its URL.
3. **⋯ → Remove member** on a member, then **⋯ → Delete repository** on the repository.
4. **⋯ → Delete project**: give a reason and approve. The pipeline deletes the project, and the catalog removes the project with its remaining members and repositories.

Azure DevOps keeps deleted projects and repositories in its recycle bin for 28–30 days (Organization settings → Projects / Repos → deleted).

## Troubleshooting

| Symptom | Cause |
|---|---|
| Step fails at once with 401 / 203 | `ADO_PAT` is wrong, expired, or lacks Build: Read & execute. |
| 404 when queuing | Wrong `organization`, `project` or `pipelineId`. |
| Run stays queued | The pipeline waits for a pool or permission approval in Azure DevOps. Open the run link. |
| Pipeline fails on `az devops project create` | The owner of `ADO_ADMIN_PAT` can't create projects, or the name is taken or reserved. |
| `group 'X' not found` | The project uses a different language or custom group names. Edit the enum in the config to match. |
| Member not added | The email is not in the organization's Entra tenant (for Entra-backed organizations). |
