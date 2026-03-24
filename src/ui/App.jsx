export function App() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        pointerEvents: 'auto',
      }}
    >
      <h1
        style={{
          fontFamily: 'Anton, sans-serif',
          fontSize: '4rem',
          color: '#e94560',
          textShadow: '2px 2px 8px rgba(0, 0, 0, 0.5)',
          letterSpacing: '0.1em',
        }}
      >
        DICEWARS
      </h1>
      <p
        style={{
          fontFamily: 'Roboto, sans-serif',
          fontSize: '1.2rem',
          color: '#a0a0b0',
          marginTop: '1rem',
        }}
      >
        Modernization in progress...
      </p>
    </div>
  );
}
