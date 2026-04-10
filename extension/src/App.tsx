export function App(): JSX.Element {
  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '24px',
        color: '#1c1c1c',
        background: '#f7f7f8',
        minHeight: '100vh',
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ margin: '0 0 12px', fontSize: '20px', fontWeight: 600 }}>
        Aperture Copilot
      </h1>
      <p style={{ margin: '0 0 8px', color: '#555' }}>
        Tableau Cloud Extension scaffold — Phase 1 placeholder.
      </p>
      <p style={{ margin: 0, color: '#888', fontSize: '13px' }}>
        The co-pilot panel UI, Tableau Extensions API bindings, and mark
        highlighter ship in Phase 4.
      </p>
    </main>
  );
}
