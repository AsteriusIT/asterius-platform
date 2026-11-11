# Nexus Repository integration

Brings a Sonatype Nexus Repository instance's repositories and stored components into the catalog, as JSON files.
The built-in `nexus` connector does the requests (basic auth, `continuationToken` paging) through the connection
`nexus`.

```
Nexus REST API ──pull every 15 min──▶  repositories   (/service/rest/v1/repositories)
               ──pull every 30 min──▶  components     (/service/rest/v1/search, every repository)
```

| File | What |
| --- | --- |
| `platform/nexus-blueprints.json` | Blueprints `nexus-repository` and `nexus-component` (component → repository relation) |
| `platform/nexus-connection.json` | Connection `nexus` (built-in `nexus` connector): API URL, public URL, user and password reference; `read` (ingestion only) |
| `platform/nexus-integrations.json` | Integrations `nexus` (repositories) and `nexus-components` (components), both of type `nexus` through the connection |

## What the catalog shows

- **Repositories**: format (`maven2`, `npm`, `docker`…), type (hosted, proxy, group), the proxied URL, and links to the
  repository and its browse page.
- **Components**: one entity per component (`group:name:version`), with its format, number of assets, total size,
  last modification and a download link to its main asset (checksums and signatures skipped). Linked to their
  repository.

Components cover every repository the user can browse, proxy caches included. On a large instance, set the
connection field `"repository": "<name>"` to read a single repository, or declare one connection (and integration)
per repository.

## Credentials

The connection signs in with a Nexus user (`auth: { type: basic, username, password }`) that only needs to browse
and search: privileges `nx-repository-view-*-*-browse`, `nx-repository-view-*-*-read` and `nx-search-read`. The
password is read from OpenBao through the platform's Vault provider, `${vault:secret/apps/nexus#password}`. Without
OpenBao, use `${secret:NEXUS_PASSWORD}` (Admin → Secrets) or `${env:NEXUS_PASSWORD}`.

The connector also has a `create-hosted-repository` operation (raw, npm or Maven hosted repositories). Using it from a
workflow needs a read-write connection and a user with `nx-repository-admin-*-*-add`; the local cluster keeps the
platform's Nexus user read-only.

## On the local OrbStack cluster

`deploy/local/install.sh` does everything:

- installs Nexus Repository Community Edition (namespace `nexus`, embedded database on a persistent volume, admin
  password from OpenBao);
- accepts the Community Edition EULA;
- creates the `asterius-platform-read` role and the `asterius-platform` user;
- mounts `platform/*.json` in the platform's configuration.

The files use the local addresses:

| Setting | Local value |
| --- | --- |
| Nexus API (in-cluster) | `http://nexus.nexus.svc:8081` |
| Nexus links in the catalog (`publicUrl`) | `https://nexus.k8s.orb.local` |

To see a component arrive, upload one (admin password in the Secret `nexus/nexus-secrets`):

```bash
curl -u admin:<password> -X POST 'https://nexus.k8s.orb.local/service/rest/v1/components?repository=maven-releases' \
  -F maven2.groupId=com.example -F maven2.artifactId=demo -F maven2.version=1.0.0 -F maven2.generate-pom=true \
  -F maven2.asset1=@demo.jar -F maven2.asset1.extension=jar
```

## Elsewhere

1. Replace the two addresses above in `platform/nexus-connection.json` (`baseUrl`, `publicUrl`) and
   `platform/nexus-integrations.json` (`publicUrl`, read by the mappings as written, so a plain URL with no `${…}`
   reference).
2. In Nexus, create a role with the three privileges above and a user with that role. Store its password where the
   reference points.
3. Put `platform/*.json` in the platform's configuration directory (`CONFIG_DIR`, Helm `config.files` /
   `config.existingConfigMap`), and check them first:

   ```bash
   npm run config:validate -w apps/server -- path/to/config
   ```
