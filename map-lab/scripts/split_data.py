#!/usr/bin/env python3
"""Spatial address shards with a small street->shards catalogue.

The test core stays bounded. Future coverage needs tiled geometry/routing too;
address sharding alone is not a claim of full-region memory scalability.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path

def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()

def split(source, destination):
    raw = source.read_bytes()
    pack = json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
    rows = pack.pop('addresses')
    shards, streets = {}, {}
    for row in rows:
        x, y = math.floor(row[1] / 2000), math.floor(row[2] / 2000)
        name = f'addresses/{x}_{y}.json.gz'
        shards.setdefault(name, []).append(row)
        street = row[0].rsplit(',', 1)[0]
        streets.setdefault(street, set()).add(name)
    destination.mkdir(parents=True, exist_ok=True)
    metadata = []
    for name, items in sorted(shards.items()):
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        content = gzip.compress(encode(items), mtime=0)
        path.write_bytes(content)
        metadata.append({'file': name, 'count': len(items), 'bytes': len(content),
                         'sha256': hashlib.sha256(content).hexdigest()})
    catalog = {'version': 1, 'count': len(rows), 'cellMeters': 2000,
               'streets': [[s, sorted(files)] for s, files in sorted(streets.items())],
               'shards': metadata}
    (destination / 'address-catalog.json').write_bytes(encode(catalog))
    pack['addressCatalog'] = 'address-catalog.json'
    (destination / 'moscow-core.json.gz').write_bytes(gzip.compress(encode(pack), mtime=0))
    manifest = {'version': 3, 'files': ['moscow-core.json.gz', 'address-catalog.json'] + sorted(shards)}
    (destination / 'manifest.json').write_bytes(encode(manifest))
    print(json.dumps({'addresses': len(rows), 'shards': len(shards),
                      'largestAddressShard': max(m['bytes'] for m in metadata),
                      'coreBytes': (destination / 'moscow-core.json.gz').stat().st_size}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    split(args.source, args.destination)
