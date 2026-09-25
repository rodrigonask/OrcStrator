import { OVERDRIVE_LEVELS } from '@shared/constants'

export function useOverdriveLevel(overdriveTasks: number, lastTaskAt: number) {
  let overdriveLevel = 0
  for (const od of OVERDRIVE_LEVELS) {
    if (overdriveTasks >= od.minTasks) overdriveLevel = od.level
    else break
  }
  const overdrive = OVERDRIVE_LEVELS[overdriveLevel]
  const minsLeft = Math.max(0, 60 - Math.floor((Date.now() - lastTaskAt) / 60_000))
  const isExpiringSoon = overdriveLevel > 0 && minsLeft < 10
  return { overdriveLevel, overdrive, minsLeft, isExpiringSoon }
}
