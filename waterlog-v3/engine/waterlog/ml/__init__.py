"""模型层：训练、加载、区间标定。

唯一依赖 sklearn/joblib 的地方，其余层只通过 load_bundle 拿到
一个 predict 接口，换模型实现时不需要动 service。"""
