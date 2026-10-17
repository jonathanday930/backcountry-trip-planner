import { Route, Routes } from 'react-router-dom'
import HomePage from './HomePage'
import PlannerPage from './PlannerPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/park/:parkId" element={<PlannerPage />} />
    </Routes>
  )
}
