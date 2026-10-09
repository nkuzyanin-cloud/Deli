#!/usr/bin/env python3
"""Prepare an offline, bounded OSM test pack. Build dependency: osmium 4.3.1.

No geocoding/routing service is called. Only a downloaded public OSM PBF is read.
Geometry crossings do not create graph connections: OSM node identity does.
"""
import argparse
import collections
import hashlib
import heapq
import json
import math
from pathlib import Path
import osmium

ORIGIN = (37.615, 55.78)
SCALE_X = 111320 * math.cos(math.radians(ORIGIN[1]))
SCALE_Y = 111320
# Deliberately a test area, not a claim of complete Moscow / Oblast coverage.
BBOX = (37.545, 55.720, 37.685, 55.840)
DENIED = {'no', 'private', 'customers', 'agricultural', 'forestry'}
WALK_ROADS = {'residential', 'living_street', 'service', 'unclassified', 'tertiary',
              'tertiary_link', 'secondary', 'secondary_link', 'primary',
              'primary_link', 'footway', 'pedestrian', 'path', 'steps', 'track',
              'cycleway', 'road', 'platform'}
ROAD_TYPES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
              'living_street', 'service', 'unclassified', 'footway', 'pedestrian',
              'path', 'steps', 'track', 'cycleway', 'road', 'platform']

def xy(lon, lat):
    return [round((lon - ORIGIN[0]) * SCALE_X, 1), round((lat - ORIGIN[1]) * SCALE_Y, 1)]

def inside(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]

def touching(points):
    return any(inside(p[0], p[1]) for p in points)

def accessible(tags):
    foot = tags.get('foot', '')
    if foot in DENIED or tags.get('indoor') == 'yes' or tags.get('level'):
        return False
    if tags.get('access') in DENIED and foot not in {'yes', 'designated', 'permissive'}:
        return False
    h = tags.get('highway', '')
    if h in {'construction', 'proposed', 'raceway', 'bus_guideway'}:
        return False
    if h in {'motorway', 'motorway_link', 'trunk', 'trunk_link'}:
        return foot in {'yes', 'designated', 'permissive'}
    if h == 'cycleway' and foot not in {'yes', 'designated', 'permissive'}:
        return False
    # Separately mapped sidewalks avoid routing straight down the carriageway.
    if tags.get('sidewalk') == 'separate' and h not in {'footway', 'path', 'pedestrian'}:
        return False
    return h in WALK_ROADS or foot in {'yes', 'designated', 'permissive'}

class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads = []
        self.polygons = []
        self.addresses = []
        self.places = []
        self.blocked_nodes = set()
        self.metro_nodes = {}
        self.metro_ways = {}
        self.metro_routes = []
        self.stop_areas = []
        self.geom = osmium.geom.GeoJSONFactory()

    def add_address(self, tags, lon, lat, source, priority):
        number = tags.get('addr:housenumber')
        street = tags.get('addr:street') or tags.get('addr:place')
        if number and street and inside(lon, lat):
            city = tags.get('addr:city', 'Москва')
            self.addresses.append({'label': f'{street}, {number}', 'city': city,
                                   'street': street, 'number': number,
                                   'p': xy(lon, lat), 'osm': source, 'priority': priority})

    def node(self, n):
        if not n.location.valid():
            return
        tags = dict(n.tags)
        lon, lat = n.location.lon, n.location.lat
        if inside(lon, lat):
            self.add_address(tags, lon, lat, 'node/' + str(n.id), 2 if tags.get('entrance') else 0)
            if tags.get('name') and (tags.get('tourism') in {'museum', 'attraction'} or
                                    tags.get('place') in {'square', 'neighbourhood'}):
                self.places.append([tags['name'], *xy(lon, lat)])
        if tags.get('railway') == 'stop' or tags.get('station') == 'subway' or tags.get('subway') == 'yes':
            self.metro_nodes[n.id] = {'p': xy(lon, lat), 'name': tags.get('name', ''),
                                     'inside': inside(lon, lat), 'tags': tags}
        if tags.get('foot') in DENIED or (tags.get('access') in DENIED and tags.get('foot') not in {'yes', 'designated', 'permissive'}):
            self.blocked_nodes.add(n.id)
        if tags.get('barrier') in {'wall', 'fence', 'retaining_wall'}:
            self.blocked_nodes.add(n.id)

    def way(self, w):
        tags = dict(w.tags)
        highway = tags.get('highway')
        rail = tags.get('railway') == 'subway' and tags.get('service') not in {'siding', 'yard', 'spur'}
        if not highway and not rail and not tags.get('addr:housenumber'):
            return
        try:
            pts = [(n.lon, n.lat) for n in w.nodes]
            ids = [n.ref for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not pts:
            return
        if rail:
            self.metro_ways[w.id] = {'ids': ids, 'points': [xy(*p) for p in pts]}
        if not touching(pts):
            return
        if highway and len(pts) >= 2:
            base = highway.replace('_link', '')
            road_type = ROAD_TYPES.index(base) if base in ROAD_TYPES else ROAD_TYPES.index('road')
            self.roads.append({'osm': w.id, 'ids': ids, 'points': [xy(*p) for p in pts],
                               'type': road_type, 'name': tags.get('name', ''),
                               'walk': accessible(tags), 'steps': highway == 'steps',
                               'direction': tags.get('oneway:foot', 'no')})
        # Object centre is a search position, not a guaranteed entrance.
        if tags.get('addr:housenumber'):
            lon = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
            lat = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
            self.add_address(tags, lon, lat, 'way/' + str(w.id), 1)

    def relation(self, r):
        tags = dict(r.tags)
        if tags.get('route') == 'subway' and tags.get('type') == 'route':
            self.metro_routes.append({'osm': r.id, 'name': tags.get('name', ''),
                                      'ref': tags.get('ref', ''),
                                      'colour': tags.get('colour', '#4582d9'),
                                      'members': [(m.type, m.ref, m.role) for m in r.members]})
        if tags.get('public_transport') == 'stop_area':
            self.stop_areas.append({'name': tags.get('name', ''),
                                    'members': [m.ref for m in r.members if m.type == 'n']})

    def area(self, a):
        tags = dict(a.tags)
        kind = None
        if tags.get('building') and tags.get('building') != 'no':
            kind = 0
        elif tags.get('natural') == 'water' or tags.get('waterway') == 'riverbank':
            kind = 1
        elif tags.get('leisure') in {'park', 'garden', 'nature_reserve'} or tags.get('landuse') in {'forest', 'grass', 'recreation_ground'} or tags.get('natural') in {'wood', 'grassland'}:
            kind = 2
        if kind is None:
            return
        try:
            geom = json.loads(self.geom.create_multipolygon(a))['coordinates']
        except Exception:
            return
        rings = []
        for poly in geom:
            if not touching(poly[0]):
                continue
            # Keep holes. Canvas uses evenodd filling.
            rings.append([[v for p in ring for v in xy(*p)] for ring in poly])
        if rings:
            self.polygons.append([kind, rings])

def shortest_rail(ways, a, b):
    graph = collections.defaultdict(list)
    coords = {}
    for way in ways:
        ids, points = way['ids'], way['points']
        coords.update(zip(ids, points))
        for i in range(len(ids)-1):
            d = math.dist(points[i], points[i+1])
            graph[ids[i]].append((ids[i+1], d))
            graph[ids[i+1]].append((ids[i], d))
    if a not in coords or b not in coords:
        return None
    dist, prev, queue = {a: 0}, {}, [(0, a)]
    while queue:
        cost, u = heapq.heappop(queue)
        if cost != dist[u]:
            continue
        if u == b:
            path = [b]
            while path[-1] != a:
                path.append(prev[path[-1]])
            return {'coords': [coords[n] for n in reversed(path)], 'meters': round(cost, 1)}
        for v, d in graph[u]:
            nd = cost + d
            if nd < dist.get(v, math.inf):
                dist[v], prev[v] = nd, u
                heapq.heappush(queue, (nd, v))
    return None

def build(source, out):
    handler = Extract()
    print('Reading OSM with original node topology and assembled polygon holes…', flush=True)
    handler.apply_file(str(source), locations=True, idx='flex_mem')
    node_index, nodes, edges, streets, street_ids, roads = {}, [], [], [], {}, []
    def node_idx(osm_id, p):
        if osm_id not in node_index:
            node_index[osm_id] = len(nodes)
            nodes.append(p)
        return node_index[osm_id]
    def street_idx(name):
        if name not in street_ids:
            street_ids[name] = len(streets)
            streets.append(name)
        return street_ids[name]
    for road in handler.roads:
        indices = [node_idx(i, p) for i, p in zip(road['ids'], road['points'])]
        street = street_idx(road['name'])
        roads.append([road['type'], street, indices])
        if not road['walk']:
            continue
        for i in range(len(indices)-1):
            if road['ids'][i] in handler.blocked_nodes or road['ids'][i+1] in handler.blocked_nodes:
                continue
            p, q = road['points'][i:i+2]
            # Both vertices must be inside: no hidden excursion outside downloaded area.
            lp = [ORIGIN[0]+p[0]/SCALE_X, ORIGIN[1]+p[1]/SCALE_Y]
            lq = [ORIGIN[0]+q[0]/SCALE_X, ORIGIN[1]+q[1]/SCALE_Y]
            if not inside(*lp) or not inside(*lq):
                continue
            length = round(math.dist(p, q), 1)
            if length <= 0:
                continue
            flags = (1 if road['steps'] else 0) | (2 if road['direction'] == 'yes' else 4 if road['direction'] == '-1' else 0)
            edges.append([indices[i], indices[i+1], length, flags, street])
    addresses = {}
    for a in sorted(handler.addresses, key=lambda a: a['priority']):
        key = (a['city'].lower(), a['label'].lower())
        addresses[key] = a
    address_rows = [[a['label'], *a['p'], a['osm'], a['city']] for a in addresses.values()]
    address_rows.sort(key=lambda r: r[0])

    # Extract only real consecutive subway stop pairs with connected track geometry.
    metro_stations, station_ids, metro_edges, seen = [], {}, [], set()
    for route in handler.metro_routes:
        stops = [ref for typ, ref, role in route['members'] if typ == 'n' and role.startswith('stop') and ref in handler.metro_nodes]
        ways = [handler.metro_ways[ref] for typ, ref, role in route['members'] if typ == 'w' and ref in handler.metro_ways]
        for a, b in zip(stops, stops[1:]):
            sa, sb = handler.metro_nodes[a], handler.metro_nodes[b]
            if not sa['inside'] or not sb['inside'] or not sa['name'] or not sb['name']:
                continue
            key = (route['ref'], a, b)
            if key in seen:
                continue
            seen.add(key)
            shape = shortest_rail(ways, a, b)
            if not shape:
                continue
            for ident, st in [(a, sa), (b, sb)]:
                skey = (ident, route['ref'])
                if skey not in station_ids:
                    station_ids[skey] = len(metro_stations)
                    metro_stations.append({'name': st['name'], 'p': st['p'], 'line': route['ref'],
                                           'colour': route['colour'], 'osm': ident})
            metro_edges.append({'a': station_ids[(a, route['ref'])], 'b': station_ids[(b, route['ref'])],
                                'line': route['ref'], 'colour': route['colour'], **shape})
    pack = {'version': 1, 'title': 'Москва · центр и север', 'origin': ORIGIN,
            'scale': [SCALE_X, SCALE_Y], 'bbox': BBOX,
            'source': {'url': 'https://download.bbbike.org/osm/bbbike/Moscow/Moscow.osm.pbf',
                       'snapshot': '2026-10-03', 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                       'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors'},
            'nodes': nodes, 'edges': edges, 'streets': streets, 'roads': roads,
            'roadTypes': ROAD_TYPES, 'polygons': handler.polygons, 'addresses': address_rows,
            'places': handler.places, 'metro': {'stations': metro_stations, 'edges': metro_edges}}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(pack, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({'bytes': out.stat().st_size, 'nodes': len(nodes), 'edges': len(edges),
                      'addresses': len(address_rows), 'roads': len(roads), 'polygons': len(handler.polygons),
                      'metroStations': len(metro_stations), 'metroEdges': len(metro_edges)}, indent=2), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    build(args.source, args.output)
