{{/* nginx: one static page for every server, the Host header picks whose data is served */}}
{{- define "vg.nginx" -}}
map $host $gs_server {
    default "";
{{- range $s := .Values.servers }}{{ range $h := $s.hosts }}
    {{ $h }} {{ $s.id }};
{{- end }}{{ end }}
}

# Title for link previews: chat apps read <title>/og: tags without running JS.
map $host $gs_title {
    default "Server stats";
{{- range $s := .Values.servers }}{{ range $h := $s.hosts }}
    {{ $h }} {{ default $s.id $s.title | quote }};
{{- end }}{{ end }}
}

server {
    listen 8080;
    listen [::]:8080;
    server_name _;
    server_tokens off;
    root /site;
    # add_header does not inherit into a location that sets its own, so each location carries its full header set.

    location = /healthz {
        access_log off;
        return 200 "ok\n";
    }

    # The data in pieces (collector/valheim_gamestats/chunks.py): index.json changes in place, every file it names never does.
    location = /index.json {
        if ($gs_server = "") { return 404; }
        root /data/site/$gs_server;
        add_header Cache-Control "no-cache" always;
        add_header Content-Security-Policy "default-src 'none'" always;
        gzip on;
        gzip_types application/json;
    }

    location ^~ /c/ {
        if ($gs_server = "") { return 404; }
        root /data/site/$gs_server;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Content-Security-Policy "default-src 'none'" always;
        gzip on;
        gzip_comp_level 6;
        gzip_types application/json;
    }


    # The map's terrain and the players' shared map, drawn by the collector; ?v=<version> makes a new drawing a new URL.
    location ~ ^/(terrain|explored)\.png$ {
        if ($gs_server = "") { return 404; }
        root /data/site/$gs_server;
        add_header Cache-Control "public, max-age=86400" always;
        add_header Content-Security-Policy "default-src 'none'" always;
    }

    # Steam achievement icons, downloaded once by the collector; names are content hashes.
    location ^~ /steam/ {
        root /data;
        add_header Cache-Control "public, max-age=2592000, immutable" always;
        add_header Content-Security-Policy "default-src 'none'" always;
    }

    # Item icons and items.json, extracted from the game's files (tools/extract_gamedata.py) onto the volume by hand.
    location ^~ /icons/ {
        root /data;
        add_header Cache-Control "public, max-age=86400" always;
        add_header Content-Security-Policy "default-src 'none'" always;
        gzip on;
        gzip_types application/json;
    }

    location / {
        try_files $uri /index.html;
        sub_filter_once on;
        sub_filter '<title>Server Stats</title>' '<title>$gs_title · stats</title><meta name="description" content="Playtime, deaths, raids, exploration and base stats for the $gs_title game server."><meta property="og:type" content="website"><meta property="og:site_name" content="{{ .Values.siteName | replace "'" "" | replace "\"" "" }}"><meta property="og:title" content="$gs_title · stats"><meta property="og:description" content="Playtime, deaths, raids, exploration and base stats for the $gs_title game server."><meta property="og:url" content="https://$host/"><meta property="og:image" content="https://$host/apple-touch-icon.png"><meta name="twitter:card" content="summary">';
        add_header Cache-Control "public, max-age=300" always;
        add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
        add_header Referrer-Policy "no-referrer" always;
        gzip on;
        gzip_types text/css application/javascript image/svg+xml;
    }
}
{{- end -}}
