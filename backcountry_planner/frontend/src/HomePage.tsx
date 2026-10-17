import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

interface Park {
  id: string
  name: string
  center: [number, number]
}

export default function HomePage() {
  const [parks, setParks] = useState<Park[]>([])

  useEffect(() => {
    fetch('/api/parks')
      .then((res) => res.json())
      .then(setParks)
      .catch(() => setParks([]))
  }, [])

  useEffect(() => {
    document.title = 'Backcountry Trip Planner'
  }, [])

  return (
    <div className="home">
      <header className="home-hero">
        <h1>Backcountry Trip Planner</h1>
        <p className="home-tagline">
          Plan wilderness backpacking trips without stitching together five different apps and a PDF map.
        </p>
        {parks.length > 0 && (
          <Link className="home-cta" to={`/park/${parks[0].id}`}>
            Start planning &rarr;
          </Link>
        )}
        <figure className="home-hero-photo">
          <img
            src="https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Longs_Peak_from_the_Dream_Lake_trail_at_sunrise%2C_Rocky_Mountain_National_Park%2C_Colorado%2C_USA.jpg/1920px-Longs_Peak_from_the_Dream_Lake_trail_at_sunrise%2C_Rocky_Mountain_National_Park%2C_Colorado%2C_USA.jpg"
            alt="Longs Peak at sunrise, seen from the Dream Lake trail in Rocky Mountain National Park"
          />
          <figcaption>
            Longs Peak, Rocky Mountain National Park &mdash; photo by OKJaguar,{' '}
            <a href="https://creativecommons.org/licenses/by-sa/4.0" target="_blank" rel="noreferrer">
              CC BY-SA 4.0
            </a>
          </figcaption>
        </figure>
      </header>

      <section className="home-section">
        <h2>What it does</h2>
        <div className="home-features">
          <div className="home-feature">
            <h3>Real backcountry sites</h3>
            <p>Designated campsites, trailheads, and campgrounds plotted on an actual topo map &mdash; not a generic pin.</p>
          </div>
          <div className="home-feature">
            <h3>On-trail distance &amp; elevation</h3>
            <p>Distance and elevation gain/loss are computed along the real trail network, not a straight line between two points.</p>
          </div>
          <div className="home-feature">
            <h3>Multi-stop itineraries</h3>
            <p>Chain together a start, any number of stops, and a destination to plan a full multi-day trip in one view.</p>
          </div>
          <div className="home-feature">
            <h3>Click anywhere</h3>
            <p>Pick a known campsite, or click any point on the map &mdash; the route still snaps to the real trail to get you there.</p>
          </div>
          <div className="home-feature">
            <h3>Save your trips</h3>
            <p>Sign in with Google to save routes and come back to them later.</p>
          </div>
        </div>
      </section>

      <section className="home-section">
        <h2>Parks</h2>
        <div className="home-park-list">
          {parks.map((p) => (
            <Link key={p.id} to={`/park/${p.id}`} className="home-park-card">
              {p.name}
            </Link>
          ))}
          {parks.length === 0 && <p className="hint">Loading parks&hellip;</p>}
        </div>
      </section>
    </div>
  )
}
