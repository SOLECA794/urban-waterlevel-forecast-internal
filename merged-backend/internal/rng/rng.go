// Package rng 确定性伪随机数发生器（Go 等价替代 numpy.random.default_rng）。
//
// 精度/行为差异说明：numpy 的 default_rng 使用 PCG64 流，Go 标准库无法逐比特复现；
// 本包用 splitmix64 作为底层流 + Box-Muller 变换生成正态样本。语义对齐点：
//   - 同一种子 → 同一序列（跨调用、跨重启稳定）
//   - uniform(lo, hi) / normal(mu, sigma) / random() 与 numpy 对应方法同语义
// 数值上不保证与 Python 版逐比特一致（对拍 golden 用例不含随机模块）。
package rng

import "math"

// RNG 确定性随机数发生器。
type RNG struct {
	state uint64
	spare *normalState
}

// New 以非负种子构造。
func New(seed uint64) *RNG {
	return &RNG{state: seed}
}

func (r *RNG) next() uint64 {
	r.state += 0x9E3779B97F4A7C15
	z := r.state
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Random 返回 [0,1) 均匀分布。
func (r *RNG) Random() float64 {
	return float64(r.next()>>11) / float64(1<<53)
}

// Uniform 返回 [lo,hi) 均匀分布。
func (r *RNG) Uniform(lo, hi float64) float64 {
	return lo + (hi-lo)*r.Random()
}

// spare 用于 Box-Muller 的成对缓存。
type normalState struct {
	spare  float64
	hasSpg bool
}

// Normal 单值正态样本 N(mu, sigma)。
func (r *RNG) Normal(mu, sigma float64) float64 {
	for {
		if r.spare != nil && r.spare.hasSpg {
			r.spare.hasSpg = false
			return mu + sigma*r.spare.spare
		}
		u1 := r.Random()
		u2 := r.Random()
		if u1 <= 1e-300 {
			continue
		}
		mag := math.Sqrt(-2.0 * math.Log(u1))
		z0 := mag * math.Cos(2*math.Pi*u2)
		z1 := mag * math.Sin(2*math.Pi*u2)
		if r.spare == nil {
			r.spare = &normalState{}
		}
		r.spare.spare = z1
		r.spare.hasSpg = true
		return mu + sigma*z0
	}
}
