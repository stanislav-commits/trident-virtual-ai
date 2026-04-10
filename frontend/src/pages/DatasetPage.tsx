import { TopBar } from '../components/layout/TopBar';

export function DatasetPage() {
  return (
    <div className="home-layout">
      <TopBar />
      <div className="home-content" style={{ justifyContent: 'center', alignItems: 'center', minHeight: 'calc(100vh - 72px)' }}>
        <div className="chat-empty__card" style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '16px', opacity: 0.3 }}>⚓</div>
          <div className="chat-empty__title" style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 8, color: 'var(--chat-text)' }}>Dataset Management</div>
          <p style={{ margin: 0, color: 'var(--chat-text-muted)', fontSize: '0.875rem', lineHeight: 1.6 }}>Documents and manuals management — coming soon.</p>
        </div>
      </div>
    </div>
  );
}
