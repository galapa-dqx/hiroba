-- DQX-26: the run registry is gone. Every pipeline runs on the flow framework
-- and the FlowHub's own SQLite (one DO, one database) is the run listing, the
-- dedup point, and the reconcile loop — nothing writes or reads this table
-- anymore. Its indexes (started_at, the partial active-item unique index from
-- 0018) drop with it.

DROP TABLE `workflow_runs`;
