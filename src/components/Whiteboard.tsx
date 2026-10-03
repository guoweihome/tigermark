import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const BOARD_W = 1600
const BOARD_H = 1000

type Tool = 'pen' | 'eraser' | 'line' | 'rect' | 'ellipse'
type Point = [number, number]

interface Stroke {
  tool: Tool
  color: string
  width: number
  points: Point[]
}

const COLORS = ['#12181f', '#c45c26', '#3d6e9e', '#2f7d4f', '#b42318', '#e6b325']
const WIDTHS = [2, 4, 8]

function isPoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  )
}

function parseBoard(raw: string): Stroke[] {
  try {
    const data = JSON.parse(raw) as { strokes?: unknown }
    if (!Array.isArray(data.strokes)) return []
    return data.strokes.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const stroke = item as Partial<Stroke>
      if (
        stroke.tool !== 'pen' &&
        stroke.tool !== 'eraser' &&
        stroke.tool !== 'line' &&
        stroke.tool !== 'rect' &&
        stroke.tool !== 'ellipse'
      ) {
        return []
      }
      if (typeof stroke.color !== 'string' || typeof stroke.width !== 'number') return []
      if (!Array.isArray(stroke.points) || !stroke.points.every(isPoint)) return []
      return [
        {
          tool: stroke.tool,
          color: stroke.color,
          width: stroke.width,
          points: stroke.points.map((point) => [point[0], point[1]] as Point),
        },
      ]
    })
  } catch {
    return []
  }
}

function serialize(strokes: Stroke[]) {
  return JSON.stringify({ version: 1, strokes })
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const points = stroke.points
  if (points.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.tool === 'eraser' ? stroke.width * 6 : stroke.width
  if (stroke.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out'
  }
  if (stroke.tool === 'pen' || stroke.tool === 'eraser') {
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    for (const point of points.slice(1)) ctx.lineTo(point[0], point[1])
    if (points.length === 1) ctx.lineTo(points[0][0] + 0.01, points[0][1])
    ctx.stroke()
  } else if (stroke.tool === 'line') {
    const end = points[points.length - 1]
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    ctx.lineTo(end[0], end[1])
    ctx.stroke()
  } else {
    const end = points[points.length - 1]
    const x = Math.min(points[0][0], end[0])
    const y = Math.min(points[0][1], end[1])
    const w = Math.abs(end[0] - points[0][0])
    const h = Math.abs(end[1] - points[0][1])
    ctx.beginPath()
    if (stroke.tool === 'rect') {
      ctx.strokeRect(x, y, w, h)
    } else {
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, 0.1), Math.max(h / 2, 0.1), 0, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  ctx.restore()
}

interface WhiteboardProps {
  value: string
  theme: 'light' | 'dark'
  readOnly?: boolean
  onChange: (value: string) => void
}

export function Whiteboard({ value, theme, readOnly = false, onChange }: WhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const emittedRef = useRef(value)
  const [strokes, setStrokes] = useState<Stroke[]>(() => parseBoard(value))
  const [redo, setRedo] = useState<Stroke[]>([])
  const [draft, setDraft] = useState<Stroke | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(4)
  const drawingRef = useRef<Stroke | null>(null)

  useEffect(() => {
    if (value === emittedRef.current) return
    emittedRef.current = value
    setStrokes(parseBoard(value))
    setRedo([])
    setDraft(null)
  }, [value])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = BOARD_W * dpr
    canvas.height = BOARD_H * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, BOARD_W, BOARD_H)
    ctx.fillStyle = theme === 'dark' ? '#1c2025' : '#ffffff'
    ctx.fillRect(0, 0, BOARD_W, BOARD_H)
    for (const stroke of strokes) drawStroke(ctx, stroke)
    if (draft) drawStroke(ctx, draft)
  }, [strokes, draft, theme])

  const commit = (next: Stroke[], nextRedo: Stroke[]) => {
    setStrokes(next)
    setRedo(nextRedo)
    const serialized = serialize(next)
    emittedRef.current = serialized
    onChange(serialized)
  }

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * BOARD_W
    const y = ((event.clientY - rect.top) / rect.height) * BOARD_H
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10]
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const stroke: Stroke = {
      tool,
      color,
      width,
      points: [pointFromEvent(event)],
    }
    drawingRef.current = stroke
    setDraft(stroke)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drawingRef.current
    if (!current) return
    const point = pointFromEvent(event)
    if (current.tool === 'pen' || current.tool === 'eraser') {
      const last = current.points[current.points.length - 1]
      const dx = point[0] - last[0]
      const dy = point[1] - last[1]
      if (dx * dx + dy * dy < 1) return
      current.points.push(point)
    } else {
      current.points = [current.points[0], point]
    }
    setDraft({ ...current, points: [...current.points] })
  }

  const finish = () => {
    const current = drawingRef.current
    drawingRef.current = null
    setDraft(null)
    if (!current || current.points.length === 0) return
    commit([...strokes, current], [])
  }

  const undo = () => {
    if (strokes.length === 0) return
    const next = strokes.slice(0, -1)
    commit(next, [...redo, strokes[strokes.length - 1]])
  }

  const redoStroke = () => {
    if (redo.length === 0) return
    const stroke = redo[redo.length - 1]
    commit([...strokes, stroke], redo.slice(0, -1))
  }

  const clear = () => {
    if (strokes.length === 0) return
    if (!window.confirm('清空这块白板？')) return
    commit([], [])
  }

  return (
    <div
      className="whiteboard"
      onKeyDown={(event) => {
        if (readOnly) return
        const meta = event.metaKey || event.ctrlKey
        if (!meta || event.key.toLowerCase() !== 'z') return
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) redoStroke()
        else undo()
      }}
      tabIndex={0}
    >
      <div className="whiteboard-toolbar">
        {readOnly ? (
          <span className="whiteboard-hint">白板在桌面端编辑，这里同步显示</span>
        ) : (
          <>
            {(
              [
                ['pen', '画笔'],
                ['eraser', '橡皮'],
                ['line', '直线'],
                ['rect', '矩形'],
                ['ellipse', '椭圆'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tool === id ? 'active' : ''}
                onClick={() => setTool(id)}
              >
                {label}
              </button>
            ))}
            <span className="whiteboard-sep" />
            {COLORS.map((item) => (
              <button
                key={item}
                type="button"
                className={`whiteboard-color${color === item ? ' active' : ''}`}
                style={{ background: item }}
                aria-label={item}
                onClick={() => {
                  setColor(item)
                  if (tool === 'eraser') setTool('pen')
                }}
              />
            ))}
            <span className="whiteboard-sep" />
            {WIDTHS.map((item) => (
              <button
                key={item}
                type="button"
                className={width === item ? 'active' : ''}
                onClick={() => setWidth(item)}
              >
                {item}
              </button>
            ))}
            <span className="whiteboard-sep" />
            <button type="button" onClick={undo} disabled={strokes.length === 0}>
              撤销
            </button>
            <button type="button" onClick={redoStroke} disabled={redo.length === 0}>
              重做
            </button>
            <button type="button" onClick={clear} disabled={strokes.length === 0}>
              清空
            </button>
          </>
        )}
      </div>
      <div className={`whiteboard-stage${theme === 'dark' ? ' is-dark' : ''}`}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
      </div>
    </div>
  )
}
