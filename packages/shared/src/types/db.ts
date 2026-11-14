/**
 * DB の接続口（db プラグインが提供する）。
 *
 * **接続先と接続の作り方だけを1か所に集める。** 接続文字列・SSL・プールの大きさを
 * プラグインごとに env から読むと、本番の DB を差し替えるたびに全部を揃え直すことになる。
 *
 * プールそのものは**使う側が用途ごとに作る**。監査と凍結判定は、記憶の重いクエリに
 * 接続を取られて詰まってはいけない（§12-7）——1本のプールを共有すると、それが起きる。
 * 作ったプールに `error` リスナを付けるのも、閉じる（teardown で `end()`）のも作った側。
 * リスナが無いと、idle 接続が切れただけでプロセスごと落ちる。
 *
 * 型引数はプールの型。shared は `pg` を持ち込まないので、使う側が渡す（`DbCapability<pg.Pool>`）。
 */
export interface DbCapability<Pool = unknown> {
  readonly dialect: "postgres";
  /** `purpose` は接続の目印（`application_name` に入る）。DB 側でどのプールの接続か追える。 */
  createPool(purpose: string): Pool;
}

export const DB_SERVICE = "db";
