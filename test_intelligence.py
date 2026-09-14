import copy
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from data import PARCELS, PACKAGES, PARCEL_SEEDS, build_parcels, build_overlap_conflict, find_parcel
from intelligence import combined_statistics, parcel_intelligence, environmental_risks
from weather import get_weather, _CACHE, demo_weather
from app import (create_package, update_package, compare, analyze, officer_action, search_parcels,
                 PackageRequest, CompareRequest, AnalysisRequest, OfficerAction)


class IntelligenceTests(unittest.TestCase):
    def test_legacy_identity_and_geometry(self):
        for original, current in zip(build_parcels(), PARCELS):
            for key in ("id", "parcel_ulpin", "parcel_display_ulpin", "position", "size", "building", "floors", "registered_area_sqft"):
                self.assertEqual(original[key], current[key], key)
        self.assertEqual(len(PARCEL_SEEDS), 12)

    def test_dataset_relationships(self):
        self.assertEqual(len(PARCELS), 84)
        self.assertEqual(sum(p["agriculture"] is not None for p in PARCELS), 48)
        self.assertEqual(len({p["id"] for p in PARCELS}), len(PARCELS))
        self.assertEqual(len({p["parcel_ulpin"] for p in PARCELS}), len(PARCELS))
        for package in PACKAGES:
            self.assertTrue(all(find_parcel(pid) for pid in package["parcel_ids"]))

    def test_deduplication_and_weighting(self):
        ids = ["P-TS-001", "P-PB-201"]
        result = combined_statistics(ids + ids)
        self.assertEqual(result["parcel_count"], 2)
        self.assertAlmostEqual(result["total_area_ha"], sum(find_parcel(pid)["area_ha"] for pid in ids))
        self.assertEqual(result["agricultural_area_ha"], find_parcel(ids[1])["area_ha"])
        self.assertEqual(result["suitability_score"], parcel_intelligence(ids[1])["suitability"]["score"])
        expected = sum(r["soil"]["ph"] * r["area_ha"] for r in result["items"]) / result["total_area_ha"]
        self.assertAlmostEqual(result["soil"]["ph"], round(expected, 2))

    def test_non_agricultural_is_not_zero_suitability(self):
        result = combined_statistics(["P-TS-001"])
        self.assertIsNone(result["suitability_score"])
        self.assertIsNone(result["water_availability"])

    def test_invalid_selections(self):
        for ids in ([], ["missing"]):
            with self.assertRaises(HTTPException):
                combined_statistics(ids)

    def test_risk_explanations_and_geography(self):
        coastal = parcel_intelligence("P-KL-401")
        flood = coastal["risks"]["hazards"]["flood"]
        self.assertGreaterEqual(flood["score"], 65)
        self.assertEqual(flood["score"], sum(c["points"] for c in flood["contributions"]))
        self.assertFalse(coastal["risks"]["hazards"]["landslide"]["applicable"])
        self.assertTrue(parcel_intelligence("P-TN-601")["risks"]["hazards"]["landslide"]["applicable"])
        self.assertGreaterEqual(parcel_intelligence("P-RJ-501")["risks"]["hazards"]["drought"]["score"], 65)

    def test_risk_reassessment(self):
        p = find_parcel("P-TS-101")
        weather = demo_weather(p)
        initial = environmental_risks(p, weather)
        for day in weather["forecast"]:
            day["temperature_max"] = 46
        changed = environmental_risks(p, weather)
        self.assertGreater(changed["hazards"]["heat"]["score"], initial["hazards"]["heat"]["score"])

    def test_cross_region_weather(self):
        s = combined_statistics(["P-KL-401", "P-RJ-501"])
        self.assertEqual(s["area_count"], 2)
        self.assertTrue(s["weather"]["different_conditions"])
        self.assertEqual(len(s["weather"]["forecast"]), 5)
        self.assertGreaterEqual(s["risks"]["worst_parcel_score"], s["risks"]["overall_score"])

    def test_weather_fallback_and_cache(self):
        _CACHE.clear()
        with patch("weather.live_weather", side_effect=OSError("offline")) as live:
            result = get_weather(PARCELS[0], "live")
            self.assertTrue(result["synthetic"])
            self.assertTrue(result["fallback_reason"])
            get_weather(PARCELS[0], "live")
            self.assertEqual(live.call_count, 1)

    def test_package_create_update_and_compare(self):
        package = create_package(PackageRequest(name="Test package", parcel_ids=["P-TS-101"] * 2))
        try:
            self.assertEqual(len(package["parcel_ids"]), 1)
            update_package(package["id"], PackageRequest(name="Updated", parcel_ids=["P-TS-101", "P-PB-201"]))
            self.assertEqual(len(package["parcel_ids"]), 2)
            result = compare(CompareRequest(targets=[{"package_id": package["id"]}, {"parcel_ids": ["P-KL-401"]}]))
            self.assertEqual(len(result["items"]), 2)
            with self.assertRaises(HTTPException):
                compare(CompareRequest(targets=[{}, {}]))
            with self.assertRaises(HTTPException):
                update_package("PKG-HYD", PackageRequest(name="No", parcel_ids=["P-TS-001"]))
        finally:
            PACKAGES.remove(package)

    def test_queries_obey_scope(self):
        ids = ["P-TS-101", "P-KL-401"]
        result = analyze(AnalysisRequest(parcel_ids=ids, question="highest_flood"))
        self.assertEqual({r["id"] for r in result["items"]}, set(ids))
        self.assertEqual(result["items"][0]["id"], "P-KL-401")
        result = analyze(AnalysisRequest(parcel_ids=ids, question="best_agriculture"))
        self.assertEqual(result["items"], [])

    def test_officer_actions(self):
        p = PARCELS[0]
        old = copy.deepcopy(p["floors"][0])
        try:
            for action in ("flag_conflict", "request_resurvey", "approve"):
                result = officer_action(p["id"], "F0", OfficerAction(action=action))
                self.assertTrue(result["ok"])
            self.assertIsNotNone(result["property_card"])
        finally:
            p["floors"][0].update(old)

    def test_overlap_preserved_and_local(self):
        self.assertEqual(build_overlap_conflict("P-TS-010")["overlap_percent"], 7.2)
        c = build_overlap_conflict("P-PB-212")
        self.assertEqual(find_parcel(c["parcel_a"])["area_id"], find_parcel(c["parcel_b"])["area_id"])


if __name__ == "__main__":
    unittest.main()
