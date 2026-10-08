{{- define "vg.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}{{- end -}}

{{- define "vg.fullname" -}}
{{- if .Values.fullnameOverride -}}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains (include "vg.name" .) .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else -}}{{ printf "%s-%s" .Release.Name (include "vg.name" .) | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "vg.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "vg.labels" -}}
{{ include "vg.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* GS_<SERVER ID>_<WHAT>: the env var a server's secret reaches the collector through */}}
{{- define "vg.env" -}}{{ printf "GS_%s_%s" (upper (regexReplaceAll "[^A-Za-z0-9]" (index . 0) "_")) (index . 1) }}{{- end -}}

{{/* a key name from secrets.keys, "{id}" replaced by the server id */}}
{{- define "vg.key" -}}{{ replace "{id}" (index . 1) (index . 0) }}{{- end -}}

{{/* config.json for the collector, from the values */}}
{{- define "vg.config" -}}
{{- $servers := list -}}
{{- range $s := .Values.servers -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]*$" $s.id) -}}{{ fail (printf "servers[].id %q: use [a-z0-9-]" $s.id) }}{{- end -}}
{{- $c := dict "id" $s.id "title" (default $s.id $s.title) "game" "valheim" "maintenance" (default list $s.maintenance) -}}
{{- with $s.world -}}
{{- $named := 0 -}}{{- range $k := list "panel" "path" "script" -}}{{- if index $s.world $k -}}{{- $named = add1 $named -}}{{- end -}}{{- end -}}
{{- if ne (int $named) 1 -}}{{ fail (printf "servers[%s].world: set exactly one of panel (Pelican), path (local) or script" $s.id) }}{{- end -}}
{{- $w := omit . "panelHost" -}}
{{- $_ := set $w "panel_host" (default "" .panelHost) -}}
{{- $_ := set $c "world" $w -}}
{{- end -}}
{{- $rcon := required (printf "servers[%s].rcon: the plugin's events come through RCON" $s.id) $s.rcon -}}
{{- $_ := set $c "rcon" (dict "password_env" (include "vg.env" (list $s.id "RCON_PASSWORD")) "host" (required (printf "servers[%s].rcon.host" $s.id) $rcon.host) "port" (default 25575 $rcon.port)) -}}
{{- with $s.steam -}}{{- $_ := set $c "steam" (deepCopy .) -}}{{- end -}}
{{- with $s.notify -}}{{- $_ := set $c "notify" (merge (dict "webhook_env" (include "vg.env" (list $s.id "DISCORD_WEBHOOK"))) (deepCopy .)) -}}{{- end -}}
{{- with $s.support -}}{{- $_ := set $c "support" (deepCopy .) -}}{{- end -}}
{{- with $s.scoring -}}{{- $_ := set $c "scoring" (deepCopy .) -}}{{- end -}}
{{- $servers = append $servers $c -}}
{{- end -}}
{{- $cfg := dict "interval" .Values.collector.interval "tz" .Values.collector.timezone
  "plugin_version" (default .Chart.AppVersion .Values.collector.pluginVersion) "alerts" (dict "webhook_env" "GS_ALERTS_WEBHOOK") "servers" $servers -}}
{{- with .Values.scoring -}}{{- $_ := set $cfg "scoring" (deepCopy .) -}}{{- end -}}
{{- toPrettyJson $cfg -}}
{{- end -}}
