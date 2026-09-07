import Dashboard from "./Dashboard";
import { WalletProvider } from "./WalletContext";

export const dynamic = "force-dynamic";

export default function Page() {
  /*
   * The wallet sits above the dashboard rather than inside the trade panel,
   * because two things need it now: the connect button in the header and the
   * buy form in the sidebar. One provider means one balance and one lock
   * timer, so the header cannot say unlocked while the panel says otherwise.
   */
  return (
    <WalletProvider>
      <Dashboard />
    </WalletProvider>
  );
}
