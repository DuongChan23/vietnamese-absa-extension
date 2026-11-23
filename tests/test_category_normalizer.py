import unittest
from backend.category_normalizer import merge_aspects,enrich_batch_response
class CategoryMergeTests(unittest.TestCase):
 def test_seracc_and_service_remain_distinct(self):
  rows=[{"start":0,"end":9,"category":"SER&ACC","sentiment":"positive"},{"start":0,"end":9,"category":"Service","sentiment":"positive"}];out=merge_aspects(rows,"visd4sa");self.assertEqual(len(out),2);self.assertEqual({x["category"] for x in out},{"SER&ACC","Service"})
 def test_only_exact_same_label_merges(self):
  rows=[{"start":0,"end":8,"category":"GENERAL","sentiment":"positive"},{"start":0,"end":8,"category":"GENERAL","sentiment":"positive"},{"start":0,"end":8,"category":"General","sentiment":"positive"}];out=merge_aspects(rows);self.assertEqual(len(out),2);self.assertEqual(out[0]["merged_count"],2)
 def test_adds_source_without_mutating_raw(self):
  response={"results":[{"aspects":[{"start":1,"end":3,"category":"Material","sentiment":"positive"}]}]};out=enrich_batch_response(response,"vicloabsa");self.assertEqual(out["results"][0]["aspects_merged"][0]["sources"],["vicloabsa"]);self.assertNotIn("aspects_merged",response["results"][0])
if __name__=="__main__":unittest.main()
