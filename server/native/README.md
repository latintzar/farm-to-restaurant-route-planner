# Native preview services

A Linux amd64 reference for serving the actual planner with native VROOM and a local Barcelona OSRM dataset. This preserves the browser's sourcing/cost logic and validates the real solver response; it supplies no replacement routing algorithm.

The operator owns the installation, state, public origin and service budgets. These files contain no existing host configuration, account grant, customer data or provider credential.

## Layout

Choose a private preview directory outside the app checkout:

```text
preview/
  source/app/             planner checkout or pinned source archive
  source/vroom/           upstream VROOM 1.15.0 source and native binary
  source/osrm-rootfs/     pinned OSRM native tools, profiles and libraries
  infra/                 these scripts and rendered unit files
  runtime/roads/          OSM extract and generated MLD files
  evidence/road-cache/    optional recorded evidence, separate from live road service
```

The verified host used Python 3.12, GCC 13 and make. Obtain the [official VROOM source](https://github.com/VROOM-Project/vroom/tree/v1.15.0) with its pinned submodules, for example `git clone --branch v1.15.0 --recurse-submodules https://github.com/VROOM-Project/vroom.git source/vroom`. Follow its upstream build prerequisites. Build VROOM from its upstream `v1.15.0` tag with pinned submodules and `make -C source/vroom/src -j2 USE_ROUTING=false`. Custom matrices still use the actual optimizer; routing HTTP transports are disabled in that binary. Preserve upstream licences.

## Local OSRM

The verified OSRM artifact is `ghcr.io/project-osrm/osrm-backend@sha256:b1ca5d72da456e82f81b8732a095c2357b00710099efa844040d1eb40b4b5386` (5.27.1, Linux amd64). Obtain the flattened runtime archive using a separately installed upstream OCI client such as Crane, without starting Docker:

```sh
crane export ghcr.io/project-osrm/osrm-backend@sha256:b1ca5d72da456e82f81b8732a095c2357b00710099efa844040d1eb40b4b5386 osrm-rootfs.tar
python3 infra/extract-native-osrm.py --archive osrm-rootfs.tar --output source/osrm-rootfs
```

Install Crane from its official publisher release and verify that release's checksum. The verified service used Crane 0.20.3. `extract-native-osrm.py` copies only required native/profile/library/notice paths, strips privileged mode bits and confines links to its fresh output directory.

Download the [BBBike Barcelona PBF and CHECKSUM.txt](https://download.bbbike.org/osm/bbbike/Barcelona/) into `runtime/roads/`, naming the PBF `barcelona.osm.pbf`. The example covers 1.80–2.48°E and 41.23–41.62°N. The verified PBF was about 73 MB; the whole stack remained below 1 GB.

Run `python3 infra/import-roads.py` for a fresh store. It checks the publisher checksum, runs extract → partition → customize with two threads, checks at least 3 GB free physical disk and 2 GB available RAM, and stops above 3 GB programme files. It refuses an existing graph. Keep live files intact: updates require a fresh versioned store and a reviewed switch. The original acceptance used about 22 seconds and a 351 MB extractor peak; new data/hardware can differ.

Map/road data is ©[OpenStreetMap contributors](https://www.openstreetmap.org/copyright), under ODbL 1.0. Keep that attribution and its data terms. The app's MIT licence covers original code and the fictional commercial fixture; upstream OSRM/VROOM/library licences remain separate.

## Start bounded services

Copy these files to `infra/`, create private runtime/evidence directories, and render the templates with your actual unprivileged service user:

```sh
python3 infra/render-units.py --preview-root /absolute/private/preview \
  --user youruser --group yourgroup --output infra/units
```

Inspect the resulting units and use your normal operator installation procedure. They run the gateway on loopback 18170 and OSRM on loopback 18172, mask other home directories, grant only the declared source/state mounts, restrict networking to loopback, and cap each service at one CPU. The gateway is limited to 384 MiB and OSRM to 512 MiB. Keep both unit names distinct from other applications on your host.

The gateway's live configuration points only to `http://127.0.0.1:18172`. It passes the app's explicit matrix payload to native VROOM with one concurrent process and one thread. The VROOM search cutoff is **soft 3 seconds**; the subprocess has a **hard 5-second wall timeout** and a **4 CPU-second limit**. JSON is limited to 64 KiB, one vehicle, 24 locations/shipments and 650 kg capacity.

Persisted preview caps are 25 solves/hour and 100/day, plus 6/minute per trusted client/proxy key. Road requests are limited to 200/hour and 1,000/day, plus 30/minute per key. Only bounded Barcelona table/route requests and fixed response options reach OSRM. Global quotas still apply when a proxy aggregates client identity. Adjust caps deliberately for your host and expected traffic.

## Ingress

`ingress.caddy.example` is a narrowly matched path handler for your own site. It strips Cookie and Authorization, sets the public path prefix and proxies to loopback. The gateway adds a validated `<base>` URL to the served entry HTML, keeping assets and data under `/preview/route-planner/` even when the edge canonical URL omits its final slash. Application JavaScript remains unchanged. Preserve the edge’s existing URL policy rather than adding an opposing redirect. If another edge transports requests, keep that anonymous routing path independent of account credentials there too.

Review and merge only this handler with the current configuration, preserving unrelated handlers. Validate with the installed server before activating through your existing operator contract; the example never replaces a shared full configuration.

## Check

```sh
python3 infra/test_gateway.py
curl --fail http://127.0.0.1:18170/healthz
```

Six provider-free tests cover request/resource bounds, confined road operations and persistent quotas. Then run a real app scenario and retain the actual OSRM matrix, native VROOM response, unchanged app validation result and road geometry with hashes. A lower full-cost browser ordering can remain selected after VROOM returns a complete alternative; the displayed route-check status distinguishes those facts.
