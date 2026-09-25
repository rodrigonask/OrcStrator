import { useMemo } from 'react'
import { useAllTasks } from '../context/AllTasksContext'
import { cardsInTrouble } from '../utils/taskSchedule'

/**
 * Scheduled cards the scheduler switched off or is skipping, across EVERY project.
 *
 * The red dot on the Pipeline icon is the entire alert mechanism for a broken routine.
 * There is no Telegram message and no email: a card that has failed three times or run out
 * of budget stops, and the only thing that says so is this dot. So it reads from
 * useAllTasks (every project at once, already mounted above both rails) rather than from
 * the active project's board, because the card that broke is almost never the project the
 * user happens to be looking at.
 */
export function useTroubledSchedules(): { count: number; titles: string[] } {
  const { allTasks } = useAllTasks()
  return useMemo(() => {
    const troubled = cardsInTrouble(allTasks)
    return { count: troubled.length, titles: troubled.map(t => t.title) }
  }, [allTasks])
}

/**
 * The dot's hover text. Names the cards rather than counting them, up to three, because
 * "2 routines need attention" sends the user to the board to find out which, and the whole
 * point of a peripheral signal is that it answers the question where it is shown.
 */
export function troubledTitle(count: number, titles: string[]): string {
  if (count === 0) return 'Pipeline'
  const shown = titles.slice(0, 3).join(', ')
  const rest = count > 3 ? `, and ${count - 3} more` : ''
  // "stopped" is wrong for an over-budget card: that one is still armed, it is just
  // skipping runs until the week rolls on. "needs attention" is true of both.
  return count === 1
    ? `Pipeline: "${shown}" needs attention`
    : `Pipeline: ${count} scheduled cards need attention (${shown}${rest})`
}
