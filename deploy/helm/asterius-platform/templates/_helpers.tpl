{{- define "ap.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ap.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "ap.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* ServiceAccount of a role. Call with (dict "root" $ "role" "api|worker"). */}}
{{- define "ap.serviceAccountName" -}}
{{- $sa := .root.Values.serviceAccount -}}
{{- $own := index $sa .role -}}
{{- if $sa.create -}}{{ $own.name | default $sa.name | default (printf "%s-%s" (include "ap.fullname" .root) .role) }}{{- else -}}{{ $own.name | default $sa.name | default "default" }}{{- end -}}
{{- end -}}

{{/* Object store credentials of the CNPG backup (S3 keys from a Secret, or a raw block for Azure / GCS). */}}
{{- define "ap.barmanCredentials" -}}
{{- $b := .Values.database.cnpg.backup -}}
{{- if $b.credentials -}}
{{- toYaml $b.credentials -}}
{{- else -}}
s3Credentials:
  accessKeyId: { name: {{ $b.s3Credentials.secretName | required "database.cnpg.backup.s3Credentials.secretName is required (or set database.cnpg.backup.credentials)" }}, key: {{ $b.s3Credentials.accessKeyIdKey }} }
  secretAccessKey: { name: {{ $b.s3Credentials.secretName }}, key: {{ $b.s3Credentials.secretAccessKeyKey }} }
{{- end -}}
{{- end -}}

{{- define "ap.secretName" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-secrets" (include "ap.fullname" .)) -}}
{{- end -}}

{{- define "ap.configMapName" -}}
{{- .Values.config.existingConfigMap | default (printf "%s-config" (include "ap.fullname" .)) -}}
{{- end -}}

{{- define "ap.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "ap.cnpgName" -}}
{{- printf "%s-db" (include "ap.fullname" .) -}}
{{- end -}}

{{/* Fail early on configurations that cannot work. */}}
{{- define "ap.validate" -}}
{{- if not (or .Values.database.url .Values.secrets.existingSecret .Values.database.cnpg.enabled) -}}
{{- fail "A PostgreSQL database is required: set database.url, DATABASE_URL in secrets.existingSecret, or database.cnpg.enabled=true" -}}
{{- end -}}
{{- if and (contains "entra" .Values.auth.providers) (not (and .Values.auth.entra.tenantId .Values.auth.entra.clientId)) -}}
{{- fail "auth.providers includes entra: set auth.entra.tenantId and auth.entra.clientId (ENTRA_CLIENT_SECRET goes in the Secret)" -}}
{{- end -}}
{{- end -}}

{{/*
Pod spec shared by the API and worker Deployments.
Call with (dict "root" $ "role" "api|worker" "resources" … "grace" N).
*/}}
{{- define "ap.podSpec" -}}
{{- $v := .root.Values -}}
serviceAccountName: {{ include "ap.serviceAccountName" (dict "root" .root "role" .role) }}
automountServiceAccountToken: {{ and (eq .role "worker") (or $v.rbac.clusterRead.enabled (gt (len $v.rbac.jobNamespaces) 0)) }}
terminationGracePeriodSeconds: {{ .grace }}
{{- with $v.imagePullSecrets }}
imagePullSecrets: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile: { type: RuntimeDefault }
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels: {{- include "ap.selector" (dict "root" .root "component" .role) | nindent 8 }}
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels: {{- include "ap.selector" (dict "root" .root "component" .role) | nindent 8 }}
{{- with $v.nodeSelector }}
nodeSelector: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.tolerations }}
tolerations: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.affinity }}
affinity: {{- toYaml . | nindent 2 }}
{{- end }}
containers:
  - name: platform
    image: {{ include "ap.image" .root | quote }}
    imagePullPolicy: {{ $v.image.pullPolicy }}
    ports:
      - { name: http, containerPort: 8080, protocol: TCP }
      {{- if $v.metrics.port }}
      - { name: metrics, containerPort: {{ $v.metrics.port }}, protocol: TCP }
      {{- end }}
    env:
      - { name: PLATFORM_ROLE, value: {{ .role | quote }} }
      - name: WORKER_ID
        valueFrom: { fieldRef: { fieldPath: metadata.name } }
      {{- if $v.database.cnpg.enabled }}
      - name: DATABASE_URL
        valueFrom: { secretKeyRef: { name: {{ include "ap.cnpgName" .root }}-app, key: uri } }
      {{- end }}
    envFrom:
      - configMapRef: { name: {{ include "ap.fullname" .root }}-env }
      - secretRef: { name: {{ include "ap.secretName" .root }} }
    volumeMounts:
      - { name: tmp, mountPath: /tmp }
      {{- if not $v.config.useImageDefaults }}
      - { name: config, mountPath: /etc/asterius/config, readOnly: true }
      {{- end }}
      {{- with $v.extraVolumeMounts }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    startupProbe:
      httpGet: { path: /readyz, port: http }
      periodSeconds: 3
      failureThreshold: 40
    readinessProbe:
      httpGet: { path: /readyz, port: http }
      periodSeconds: 10
      failureThreshold: 3
    livenessProbe:
      httpGet: { path: /healthz, port: http }
      periodSeconds: 20
      failureThreshold: 3
    lifecycle:
      # Let endpoints / load balancers drop the pod before it stops accepting connections.
      preStop: { sleep: { seconds: 5 } }
    resources: {{- toYaml .resources | nindent 6 }}
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: { drop: [ALL] }
  {{- with $v.extraContainers }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
volumes:
  - name: tmp
    emptyDir: { sizeLimit: 256Mi }
  {{- if not $v.config.useImageDefaults }}
  - name: config
    configMap: { name: {{ include "ap.configMapName" .root }} }
  {{- end }}
  {{- with $v.extraVolumes }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- end -}}
