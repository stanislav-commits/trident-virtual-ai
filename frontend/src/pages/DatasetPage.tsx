import type { TopBarTab } from '../components/layout/TopBar';
import { TopBar } from '../components/layout/TopBar';

interface DatasetPageProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
}

export function DatasetPage({ activeTab, onTabChange }: DatasetPageProps) {
  return (
    <div className="home-layout">
      <TopBar activeTab={activeTab} onTabChange={onTabChange} />
      <div className="home-content">
        <div className="chat-empty__card">
          <div className="chat-empty__title">Dataset</div>
          <p>Documents and manuals management — coming soon.</p>
        </div>
      </div>
    </div>
  );
}
