// Package repo 数据访问层（sqlx 手写 SQL）。只做 CRUD 与查询，不含业务规则。
package repo

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"waterlog/v2/internal/db"
	"waterlog/v2/internal/model"
)

// Repo 全部实体的仓储入口。
type Repo struct {
	db *db.DB
}

func New(d *db.DB) *Repo { return &Repo{db: d} }

// ---------- DeviceProfile ----------

func (r *Repo) ListProfiles() ([]model.DeviceProfile, error) {
	var rows []model.DeviceProfile
	if err := r.db.Select(&rows, `SELECT * FROM device_profile ORDER BY id`); err != nil {
		return nil, err
	}
	for i := range rows {
		_ = json.Unmarshal([]byte(rows[i].TelemetryKeys), &rows[i].Keys)
	}
	return rows, nil
}

func (r *Repo) GetProfile(id int64) (*model.DeviceProfile, error) {
	var p model.DeviceProfile
	if err := r.db.Get(&p, `SELECT * FROM device_profile WHERE id=?`, id); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(p.TelemetryKeys), &p.Keys)
	return &p, nil
}

func (r *Repo) CreateProfile(p *model.DeviceProfile) error {
	keys, _ := json.Marshal(p.Keys)
	now := time.Now().Unix()
	res, err := r.db.Exec(`INSERT INTO device_profile(name,category,telemetry_keys,description,created_at,updated_at)
		VALUES(?,?,?,?,?,?)`, p.Name, p.Category, string(keys), p.Description, now, now)
	if err != nil {
		return err
	}
	p.ID, _ = res.LastInsertId()
	p.CreatedAt, p.UpdatedAt = now, now
	p.TelemetryKeys = string(keys)
	return nil
}

func (r *Repo) UpdateProfile(p *model.DeviceProfile) error {
	keys, _ := json.Marshal(p.Keys)
	now := time.Now().Unix()
	_, err := r.db.Exec(`UPDATE device_profile SET name=?,category=?,telemetry_keys=?,description=?,updated_at=? WHERE id=?`,
		p.Name, p.Category, string(keys), p.Description, now, p.ID)
	return err
}

func (r *Repo) DeleteProfile(id int64) error {
	var n int
	if err := r.db.Get(&n, `SELECT COUNT(*) FROM device WHERE profile_id=?`, id); err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("该画像下仍有 %d 台设备，不能删除", n)
	}
	_, err := r.db.Exec(`DELETE FROM device_profile WHERE id=?`, id)
	return err
}

// ---------- Device ----------

const deviceSelect = `SELECT d.*, p.name AS profile_name FROM device d JOIN device_profile p ON p.id=d.profile_id`

func (r *Repo) ListDevices() ([]model.Device, error) {
	var rows []model.Device
	if err := r.db.Select(&rows, deviceSelect+` ORDER BY d.id`); err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *Repo) GetDevice(id int64) (*model.Device, error) {
	var d model.Device
	if err := r.db.Get(&d, deviceSelect+` WHERE d.id=?`, id); err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *Repo) GetDeviceByCode(code string) (*model.Device, error) {
	var d model.Device
	if err := r.db.Get(&d, deviceSelect+` WHERE d.code=?`, code); err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *Repo) CreateDevice(d *model.Device) error {
	now := time.Now().Unix()
	res, err := r.db.Exec(`INSERT INTO device(profile_id,name,code,lat,lon,address,status,enabled,last_seen_at,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		d.ProfileID, d.Name, d.Code, d.Lat, d.Lon, d.Address, d.Status, d.Enabled, d.LastSeenAt, now, now)
	if err != nil {
		return err
	}
	d.ID, _ = res.LastInsertId()
	d.CreatedAt, d.UpdatedAt = now, now
	return nil
}

func (r *Repo) UpdateDevice(d *model.Device) error {
	now := time.Now().Unix()
	_, err := r.db.Exec(`UPDATE device SET profile_id=?,name=?,code=?,lat=?,lon=?,address=?,enabled=?,updated_at=? WHERE id=?`,
		d.ProfileID, d.Name, d.Code, d.Lat, d.Lon, d.Address, d.Enabled, now, d.ID)
	return err
}

func (r *Repo) DeleteDevice(id int64) error {
	_, err := r.db.Exec(`DELETE FROM device WHERE id=?`, id)
	return err
}

func (r *Repo) TouchDevice(deviceID int64, ts int64) error {
	_, err := r.db.Exec(`UPDATE device SET last_seen_at=?, status=? WHERE id=?`, ts, model.DeviceOnline, deviceID)
	return err
}

// MarkStaleDevices 将超过阈值的在线设备标记为 stale。
func (r *Repo) MarkStaleDevices(cutoff int64) error {
	_, err := r.db.Exec(`UPDATE device SET status='stale' WHERE enabled=1 AND status='online' AND (last_seen_at IS NULL OR last_seen_at < ?)`, cutoff)
	return err
}

// ---------- Telemetry ----------

// InsertTelemetry 批量写入（单事务）。
func (r *Repo) InsertTelemetry(rows []model.Telemetry) error {
	if len(rows) == 0 {
		return nil
	}
	tx, err := r.db.Beginx()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO telemetry_kv(device_id,metric,ts,value,quality) VALUES(?,?,?,?,?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, t := range rows {
		if _, err := stmt.Exec(t.DeviceID, t.Metric, t.Ts, t.Value, t.Quality); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// Series 原始序列（升序）。
func (r *Repo) Series(deviceID int64, metric string, from, to int64, limit int) ([]model.Telemetry, error) {
	if limit <= 0 {
		limit = 500
	}
	var rows []model.Telemetry
	err := r.db.Select(&rows, `SELECT * FROM telemetry_kv WHERE device_id=? AND metric=? AND ts>=? AND ts<=?
		ORDER BY ts DESC LIMIT ?`, deviceID, metric, from, to, limit)
	// 反转为升序供图表
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, err
}

// LatestValue 某设备某指标的最新值。
func (r *Repo) LatestValue(deviceID int64, metric string) (*model.Telemetry, error) {
	var t model.Telemetry
	err := r.db.Get(&t, `SELECT * FROM telemetry_kv WHERE device_id=? AND metric=? ORDER BY ts DESC LIMIT 1`, deviceID, metric)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// LatestMetrics 一台设备各指标的最新值。
func (r *Repo) LatestMetrics(deviceID int64) (map[string]model.Telemetry, error) {
	var rows []model.Telemetry
	err := r.db.Select(&rows, `SELECT t.* FROM telemetry_kv t
		JOIN (SELECT metric, MAX(ts) AS mts FROM telemetry_kv WHERE device_id=? GROUP BY metric) x
		  ON x.metric=t.metric AND x.mts=t.ts
		WHERE t.device_id=?`, deviceID, deviceID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]model.Telemetry, len(rows))
	for _, t := range rows {
		out[t.Metric] = t
	}
	return out, nil
}

// PurgeOlderThan 清理过期遥测（保留窗口）。
func (r *Repo) PurgeOlderThan(cutoff int64) error {
	_, err := r.db.Exec(`DELETE FROM telemetry_kv WHERE ts < ?`, cutoff)
	return err
}

// ---------- RuleChain / RuleNode ----------

func (r *Repo) ListChains() ([]model.RuleChain, error) {
	var rows []model.RuleChain
	if err := r.db.Select(&rows, `SELECT * FROM rule_chain ORDER BY id`); err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *Repo) GetChain(id int64) (*model.RuleChain, error) {
	var c model.RuleChain
	if err := r.db.Get(&c, `SELECT * FROM rule_chain WHERE id=?`, id); err != nil {
		return nil, err
	}
	nodes, err := r.ListNodesByChain(id)
	if err != nil {
		return nil, err
	}
	c.Nodes = nodes
	return &c, nil
}

func (r *Repo) CreateChain(c *model.RuleChain) error {
	now := time.Now().Unix()
	res, err := r.db.Exec(`INSERT INTO rule_chain(name,description,enabled,created_at,updated_at) VALUES(?,?,?,?,?)`,
		c.Name, c.Description, c.Enabled, now, now)
	if err != nil {
		return err
	}
	c.ID, _ = res.LastInsertId()
	c.CreatedAt, c.UpdatedAt = now, now
	return nil
}

func (r *Repo) UpdateChain(c *model.RuleChain) error {
	now := time.Now().Unix()
	_, err := r.db.Exec(`UPDATE rule_chain SET name=?,description=?,enabled=?,updated_at=? WHERE id=?`,
		c.Name, c.Description, c.Enabled, now, c.ID)
	return err
}

func (r *Repo) DeleteChain(id int64) error {
	_, err := r.db.Exec(`DELETE FROM rule_chain WHERE id=?`, id)
	return err
}

func (r *Repo) ListNodesByChain(chainID int64) ([]model.RuleNode, error) {
	var rows []model.RuleNode
	if err := r.db.Select(&rows, `SELECT * FROM rule_node WHERE chain_id=? ORDER BY priority,id`, chainID); err != nil {
		return nil, err
	}
	for i := range rows {
		_ = json.Unmarshal([]byte(rows[i].Actions), &rows[i].ActionsList)
	}
	return rows, nil
}

// ListEnabledNodes 全部启用链路下的启用节点（规则引擎热路径）。
func (r *Repo) ListEnabledNodes() ([]model.RuleNode, error) {
	var rows []model.RuleNode
	err := r.db.Select(&rows, `SELECT n.* FROM rule_node n JOIN rule_chain c ON c.id=n.chain_id
		WHERE n.enabled=1 AND c.enabled=1 ORDER BY n.priority,n.id`)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		_ = json.Unmarshal([]byte(rows[i].Actions), &rows[i].ActionsList)
	}
	return rows, nil
}

func (r *Repo) GetNode(id int64) (*model.RuleNode, error) {
	var n model.RuleNode
	if err := r.db.Get(&n, `SELECT * FROM rule_node WHERE id=?`, id); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(n.Actions), &n.ActionsList)
	return &n, nil
}

func (r *Repo) CreateNode(n *model.RuleNode) error {
	now := time.Now().Unix()
	actions, _ := json.Marshal(n.ActionsList)
	res, err := r.db.Exec(`INSERT INTO rule_node(chain_id,name,device_profile_id,metric,op,threshold,duration_sec,
		level_key,level_rank,severity,actions,priority,enabled,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		n.ChainID, n.Name, n.DeviceProfileID, n.Metric, n.Op, n.Threshold, n.DurationSec,
		n.LevelKey, n.LevelRank, n.Severity, string(actions), n.Priority, n.Enabled, now, now)
	if err != nil {
		return err
	}
	n.ID, _ = res.LastInsertId()
	n.CreatedAt, n.UpdatedAt = now, now
	n.Actions = string(actions)
	return nil
}

func (r *Repo) UpdateNode(n *model.RuleNode) error {
	now := time.Now().Unix()
	actions, _ := json.Marshal(n.ActionsList)
	_, err := r.db.Exec(`UPDATE rule_node SET name=?,device_profile_id=?,metric=?,op=?,threshold=?,duration_sec=?,
		level_key=?,level_rank=?,severity=?,actions=?,priority=?,enabled=?,updated_at=? WHERE id=?`,
		n.Name, n.DeviceProfileID, n.Metric, n.Op, n.Threshold, n.DurationSec,
		n.LevelKey, n.LevelRank, n.Severity, string(actions), n.Priority, n.Enabled, now, n.ID)
	return err
}

func (r *Repo) DeleteNode(id int64) error {
	_, err := r.db.Exec(`DELETE FROM rule_node WHERE id=?`, id)
	return err
}

// ---------- Alarm ----------

func (r *Repo) CreateAlarm(a *model.Alarm) error {
	now := time.Now().Unix()
	a.UpdatedAt = now
	res, err := r.db.Exec(`INSERT INTO alarm(device_id,rule_node_id,level_key,level_rank,severity,status,start_ts,
		trigger_value,current_value,message,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		a.DeviceID, a.RuleNodeID, a.LevelKey, a.LevelRank, a.Severity, a.Status, a.StartTs,
		a.TriggerValue, a.CurrentValue, a.Message, now)
	if err != nil {
		return err
	}
	a.ID, _ = res.LastInsertId()
	return nil
}

const alarmSelect = `SELECT a.*, d.name AS device_name, d.code AS device_code FROM alarm a JOIN device d ON d.id=a.device_id`

func (r *Repo) GetAlarm(id int64) (*model.Alarm, error) {
	var a model.Alarm
	if err := r.db.Get(&a, alarmSelect+` WHERE a.id=?`, id); err != nil {
		return nil, err
	}
	return &a, nil
}

// ActiveAlarm 某设备某规则当前是否已有生效告警。
func (r *Repo) ActiveAlarm(deviceID int64, ruleNodeID int64) (*model.Alarm, error) {
	var a model.Alarm
	err := r.db.Get(&a, alarmSelect+` WHERE a.device_id=? AND a.rule_node_id=? AND a.status IN (?,?) ORDER BY a.id DESC LIMIT 1`,
		deviceID, ruleNodeID, model.AlarmActiveUnack, model.AlarmActiveAck)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// LastCleared 同设备同规则最近一次解除的告警（用于重复触发冷却）。
func (r *Repo) LastCleared(deviceID int64, ruleNodeID int64) (*model.Alarm, error) {
	var a model.Alarm
	err := r.db.Get(&a, alarmSelect+` WHERE a.device_id=? AND a.rule_node_id=? AND a.status IN (?,?)
		ORDER BY a.clear_ts DESC LIMIT 1`, deviceID, ruleNodeID, model.AlarmClearedUnack, model.AlarmClearedAck)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// UpdateAlarmState 状态机落库。
func (r *Repo) UpdateAlarmState(a *model.Alarm) error {
	now := time.Now().Unix()
	_, err := r.db.Exec(`UPDATE alarm SET status=?,ack_ts=?,ack_by=?,clear_ts=?,cleared_by=?,clear_reason=?,
		current_value=?,updated_at=? WHERE id=?`,
		a.Status, a.AckTs, a.AckBy, a.ClearTs, a.ClearedBy, a.ClearReason, a.CurrentValue, now, a.ID)
	return err
}

// AlarmFilter 列表筛选条件。
type AlarmFilter struct {
	Status     string
	LevelKey   string
	DeviceID   int64
	ActiveOnly bool
	Page       int
	PageSize   int
}

func (r *Repo) ListAlarms(f AlarmFilter) ([]model.Alarm, int, error) {
	where := []string{"1=1"}
	args := []any{}
	if f.Status == "cleared" {
		// 已恢复（含未确认/已确认两态）
		where = append(where, "a.status IN (?,?)")
		args = append(args, model.AlarmClearedUnack, model.AlarmClearedAck)
	} else if f.Status != "" {
		where = append(where, "a.status=?")
		args = append(args, f.Status)
	}
	if f.ActiveOnly {
		where = append(where, "a.status IN (?,?)")
		args = append(args, model.AlarmActiveUnack, model.AlarmActiveAck)
	}
	if f.LevelKey != "" {
		where = append(where, "a.level_key=?")
		args = append(args, f.LevelKey)
	}
	if f.DeviceID > 0 {
		where = append(where, "a.device_id=?")
		args = append(args, f.DeviceID)
	}
	cond := strings.Join(where, " AND ")
	var total int
	if err := r.db.Get(&total, `SELECT COUNT(*) FROM alarm a WHERE `+cond, args...); err != nil {
		return nil, 0, err
	}
	if f.PageSize <= 0 {
		f.PageSize = 20
	}
	if f.Page < 1 {
		f.Page = 1
	}
	args = append(args, f.PageSize, (f.Page-1)*f.PageSize)
	var rows []model.Alarm
	err := r.db.Select(&rows, alarmSelect+` WHERE `+cond+` ORDER BY a.status IN ('ACTIVE_UNACK','ACTIVE_ACK') DESC, a.start_ts DESC LIMIT ? OFFSET ?`, args...)
	return rows, total, err
}

func (r *Repo) AlarmStats(todayStart int64) (*model.AlarmStats, error) {
	st := &model.AlarmStats{ByLevel: map[string]int64{}, ByStatus: map[string]int64{}}
	if err := r.db.Get(&st.ActiveTotal, `SELECT COUNT(*) FROM alarm WHERE status IN (?,?)`,
		model.AlarmActiveUnack, model.AlarmActiveAck); err != nil {
		return nil, err
	}
	if err := r.db.Get(&st.UnackTotal, `SELECT COUNT(*) FROM alarm WHERE status=?`, model.AlarmActiveUnack); err != nil {
		return nil, err
	}
	if err := r.db.Get(&st.TodayTotal, `SELECT COUNT(*) FROM alarm WHERE start_ts>=?`, todayStart); err != nil {
		return nil, err
	}
	type kv struct {
		K string `db:"k"`
		N int64  `db:"n"`
	}
	var lv []kv
	if err := r.db.Select(&lv, `SELECT level_key AS k, COUNT(*) AS n FROM alarm WHERE status IN (?,?) GROUP BY level_key`,
		model.AlarmActiveUnack, model.AlarmActiveAck); err != nil {
		return nil, err
	}
	for _, x := range lv {
		st.ByLevel[x.K] = x.N
	}
	var bs []kv
	if err := r.db.Select(&bs, `SELECT status AS k, COUNT(*) AS n FROM alarm GROUP BY status`); err != nil {
		return nil, err
	}
	for _, x := range bs {
		st.ByStatus[x.K] = x.N
	}
	// 当前生效的最高等级
	type row struct {
		K string `db:"level_key"`
	}
	var top []row
	if err := r.db.Select(&top, `SELECT level_key FROM alarm WHERE status IN (?,?) ORDER BY level_rank DESC LIMIT 1`,
		model.AlarmActiveUnack, model.AlarmActiveAck); err == nil && len(top) > 0 {
		k := top[0].K
		st.MaxActiveLevel = &k
	} else if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	return st, nil
}

// ---------- Dashboard ----------

func (r *Repo) CreateDashboard(d *model.Dashboard) (*model.Dashboard, error) {
	now := time.Now().Unix()
	res, err := r.db.Exec(`INSERT INTO dashboard(name,is_default,layout,widgets,updated_at) VALUES(?,?,?,?,?)`,
		d.Name, d.IsDefault, d.Layout, d.Widgets, now)
	if err != nil {
		return nil, err
	}
	d.ID, _ = res.LastInsertId()
	d.UpdatedAt = now
	return d, nil
}

func (r *Repo) GetDefaultDashboard() (*model.Dashboard, error) {
	var d model.Dashboard
	if err := r.db.Get(&d, `SELECT * FROM dashboard WHERE is_default=1 ORDER BY id LIMIT 1`); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(d.Layout), &d.LayoutList)
	_ = json.Unmarshal([]byte(d.Widgets), &d.WidgetsList)
	return &d, nil
}

func (r *Repo) UpdateDashboard(d *model.Dashboard) error {
	layout, _ := json.Marshal(d.LayoutList)
	widgets, _ := json.Marshal(d.WidgetsList)
	now := time.Now().Unix()
	_, err := r.db.Exec(`UPDATE dashboard SET name=?,layout=?,widgets=?,updated_at=? WHERE id=?`,
		d.Name, string(layout), string(widgets), now, d.ID)
	d.Layout, d.Widgets, d.UpdatedAt = string(layout), string(widgets), now
	return err
}

// ---------- Audit ----------

func (r *Repo) Audit(actor, action, target, detail string) {
	_, _ = r.db.Exec(`INSERT INTO audit_log(ts,actor,action,target,detail) VALUES(?,?,?,?,?)`,
		time.Now().Unix(), actor, action, target, detail)
}

// ---------- 预警等级视图（由规则节点推导，供前端图例/阈值线） ----------

// LevelView 等级视图。
type LevelView struct {
	Rank       int64   `db:"rank" json:"rank"`
	LevelKey   string  `db:"level_key" json:"levelKey"`
	Threshold  float64 `db:"threshold" json:"waterLevelThreshold"`
	NodeName   string  `db:"node_name" json:"name"`
}

// WaterLevelLevels 从水位规则节点推导四级阈值（同等级取最小阈值）。
func (r *Repo) WaterLevelLevels() ([]LevelView, error) {
	var rows []LevelView
	err := r.db.Select(&rows, `SELECT level_rank AS rank, level_key AS level_key, MIN(threshold) AS threshold,
		MIN(name) AS node_name FROM rule_node WHERE metric='water_level' AND enabled=1
		GROUP BY level_rank, level_key ORDER BY level_rank`)
	return rows, err
}

// LatestAll 全部设备各指标最新值（总览页批量查询）。
func (r *Repo) LatestAll() ([]model.Telemetry, error) {
	var rows []model.Telemetry
	err := r.db.Select(&rows, `SELECT t.* FROM telemetry_kv t
		JOIN (SELECT device_id, metric, MAX(ts) AS mts FROM telemetry_kv GROUP BY device_id, metric) x
		  ON x.device_id=t.device_id AND x.metric=t.metric AND x.mts=t.ts`)
	return rows, err
}
