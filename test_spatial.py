import copy
import json
import math
import unittest
from unittest.mock import patch

from data import AREAS, PARCELS, expand_parcels, find_floor
from spatial import assign_spatial_layouts
from intelligence import combined_statistics, parcel_intelligence


class SpatialTests(unittest.TestCase):
    def test_parcel_and_building_semantics(self):
        for p in PARCELS:
            self.assertEqual(p["land_use"], p["property_type"])
            if p["agriculture"]:
                self.assertEqual(p["buildings"], [])
                self.assertEqual(p["building"]["floors"], [])
                self.assertEqual(p["building"]["height"], 0)
            for b in p["buildings"]:
                self.assertEqual(b["parcel_id"], p["id"])
                self.assertNotIn("soil", b)
                self.assertNotIn("land_use", b)
                self.assertIn("building", b["type"])
                self.assertAlmostEqual(b["height"], len(b["floors"]) * b["floor_h"], places=3)
                self.assertIs(b["floors"], p["floors"])

    def test_buildings_do_not_change_parcel_statistics(self):
        p = copy.deepcopy(next(p for p in PARCELS if p["area_id"] == "JOD" and p["agriculture"]))
        with patch("intelligence.resolve_parcels", return_value=[p]), patch("intelligence.find_parcel", return_value=p):
            before = combined_statistics([p["id"]])
            structure = copy.deepcopy(PARCELS[0]["building"])
            structure.update(type="Farm storage building", parcel_id=p["id"])
            structure["floors"][0]["id"] = "B1-F0"
            p["buildings"] = [structure]
            self.assertIs(find_floor(p, "B1-F0"), structure["floors"][0])
            p["property_type"] = "Commercial"  # Legacy alias must not override canonical land use.
            after = combined_statistics([p["id"]])
            self.assertEqual(after["land_use_ha"], {"Agricultural": p["area_ha"]})
            for key in ("land_use_ha", "agricultural_area_ha", "total_area_ha", "soil", "weather", "risks"):
                self.assertEqual(before[key], after[key], key)
            self.assertEqual(parcel_intelligence(p["id"])["land_use"], "Agricultural")

    def test_preserves_analytical_records(self):
        originals = expand_parcels()
        for before, after in zip(originals, PARCELS):
            for key in before.keys() - {"position", "size", "building"}:
                self.assertEqual(before[key], after[key], (before["id"], key))

    def test_deterministic_distinct_local_layouts(self):
        rebuilt, areas = expand_parcels(), copy.deepcopy(AREAS)
        assign_spatial_layouts(rebuilt, areas)
        self.assertEqual(rebuilt, PARCELS)
        signatures = set()
        for area in areas:
            parcels = [p for p in rebuilt if p["area_id"] == area["id"]]
            self.assertEqual(len(parcels), 12)
            self.assertTrue(area["spatial"]["roads"])
            signatures.add(json.dumps([(p["boundary"], p["building"]) for p in parcels]))
            self.assertLess(max(abs(v) for p in parcels for v in p["position"].values()), 100)
        self.assertEqual(len(signatures), len(areas))

    def test_valid_polygons_and_contained_footprints(self):
        for parcel in PARCELS:
            boundary = parcel["boundary"]
            self.assertGreaterEqual(len(boundary), 4)
            self.assertTrue(all(math.isfinite(v) for point in boundary for v in point.values()))
            x, z = parcel["position"]["x"], parcel["position"]["z"]
            for axis, size in [("x", "w"), ("z", "d")]:
                span = max(p[axis] for p in boundary) - min(p[axis] for p in boundary)
                self.assertAlmostEqual(span, parcel["size"][size], places=3)
            if parcel["agriculture"]:
                self.assertGreater(parcel["cultivation_pattern"]["spacing"], 0)
                continue
            building = parcel["building"]
            self.assertGreater(building["floor_h"], 0)
            for point in building["footprint"]:
                px, pz = x + building["offset"]["x"] + point["x"], z + building["offset"]["z"] + point["z"]
                cross = []
                for i, a in enumerate(boundary):
                    b = boundary[(i + 1) % len(boundary)]
                    cross.append((b["x"] - a["x"]) * (pz - a["z"]) - (b["z"] - a["z"]) * (px - a["x"]))
                self.assertTrue(all(v >= -1e-3 for v in cross) or all(v <= 1e-3 for v in cross), parcel["id"])


if __name__ == "__main__":
    unittest.main()
