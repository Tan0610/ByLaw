import { Account, Empty, ErrorBox, Loading, NeedWallet, PageHead, Stat, Table, TxStatus, useTx } from "../components/ui";
import { fmtToken } from "../lib/format";
import { useAgents, useClaimable, useIds, useSeats } from "../lib/hooks";

export default function SeatsPage() {
  const seats = useSeats();
  const agents = useAgents();
  const ids = useIds();
  const tx = useTx();
  const me = tx.accountId;
  const claimable = useClaimable(me);

  const totalW = (seats.data ?? []).reduce((s, x) => s + x.weight, 0);
  const myAgents = (agents.data ?? []).filter((a) => a.owner === me);

  return (
    <>
      <PageHead title="Seats and claims" lead="Seat NFTs carry revenue weight and guardian rights, and they are transferable. Every accepted job credits seat holders; owners of agents and seats claim what they earned." />
      <NeedWallet what="see and claim your balance" />
      {me && (
        <section className="card" aria-labelledby="bal">
          <h2 id="bal">Your claimable balance</h2>
          <div className="row spread">
            <Stat label={`for ${me}`} value={`${fmtToken(claimable.data?.amount)} tUSD`} />
            <button className="primary" disabled={tx.state.status === "pending" || !claimable.data || claimable.data.amount === "0"}
              onClick={() => void tx.run({ receiverId: ids.contractId, methodName: "claim", args: {} }, "Claim sent. tUSD arrives in your wallet.")}>
              Claim tUSD
            </button>
          </div>
          {myAgents.length > 0 && <p className="small muted">You own {myAgents.map((a) => a.account).join(", ")}; their earnings land in this balance.</p>}
        </section>
      )}
      <TxStatus state={tx.state} />

      <section className="card" aria-labelledby="seats">
        <h2 id="seats">Seats</h2>
        {seats.isLoading ? <Loading what="seats" /> : seats.error ? <ErrorBox error={seats.error} retry={() => seats.refetch()} /> :
          !seats.data?.length ? <Empty>No seats minted yet. The DAO mints seats with mint_seat.</Empty> : (
            <Table label="Seat NFTs">
              <thead><tr><th>Seat</th><th>Owner</th><th className="num">Weight</th><th className="num">Share</th><th className="num">Pending dividends</th><th /></tr></thead>
              <tbody>
                {seats.data.map((s) => (
                  <tr key={s.token_id}>
                    <td>#{s.token_id}</td>
                    <td><Account id={s.owner} />{s.owner === me && <> <span className="badge info">you</span></>}</td>
                    <td className="num">{s.weight}</td>
                    <td className="num">{totalW ? ((s.weight / totalW) * 100).toFixed(0) : 0}%</td>
                    <td className="num">{fmtToken(s.pending)} tUSD</td>
                    <td>
                      <button className="sm" disabled={s.owner !== me || s.pending === "0" || tx.state.status === "pending"} aria-label={`Credit pending dividends of seat ${s.token_id} to my balance`}
                        onClick={() => void tx.run({ receiverId: ids.contractId, methodName: "checkpoint_seat", args: { token_id: s.token_id } }, "Pending dividends credited. Now claim your balance.")}>
                        Credit to balance
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        <p className="small muted">Dividends use a cumulative accumulator: pending = weight × (accumulator − last checkpoint). Crediting moves pending into your claimable balance; claiming pays it out.</p>
      </section>
    </>
  );
}
