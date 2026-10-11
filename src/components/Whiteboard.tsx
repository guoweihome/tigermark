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

const LIGHT_COLORS = ['#12181f', '#c45c26', '#3d6e9e', '#2f7d4f', '#b42318', '#e6b325']
const DARK_COLORS = ['#f4f1ea', '#e08a4f', '#8eb6e0', '#7dcea0', '#f07178', '#e6b325']
const WIDTHS = [2, 4, 8]

function paletteFor(theme: 'light' | 'dark') {
  return theme === 'dark' ? DARK_COLORS : LIGHT_COLORS
}

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
  const [color, setColor] = useState(() => paletteFor(theme)[0])
  const [width, setWidth] = useState(4)
  const drawingRef = useRef<Stroke | null>(null)
  const colors = paletteFor(theme)

  useEffect(() => {
    setColor((current) => (paletteFor(theme).includes(current) ? current : paletteFor(theme)[0]))
  }, [theme])

  useEffect(() => {
    if (value === emittedRef.current) return
    emittedRef.current = value
    setStrokes(parseBoard(value))
    setRedo([])
    setDraft(null)
  }, [value])

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = canvas?.parentElement
    if (!canvas || !stage) return

    const paint = () => {
      const rect = stage.getBoundingClientRect()
      const availW = Math.max(1, rect.width - 32)
      const availH = Math.max(1, rect.height - 32)
      const ratio = BOARD_W / BOARD_H
      let cssWidth = availW
      let cssHeight = cssWidth / ratio
      if (cssHeight > availH) {
        cssHeight = availH
        cssWidth = cssHeight * ratio
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const bitmapW = Math.max(1, Math.round(cssWidth * dpr))
      const bitmapH = Math.max(1, Math.round(cssHeight * dpr))
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
        canvas.width = bitmapW
        canvas.height = bitmapH
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const scale = cssWidth / BOARD_W
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
      ctx.clearRect(0, 0, BOARD_W, BOARD_H)
      ctx.fillStyle = theme === 'dark' ? '#1c2025' : '#ffffff'
      ctx.fillRect(0, 0, BOARD_W, BOARD_H)
      for (const stroke of strokes) drawStroke(ctx, stroke)
      if (draft) drawStroke(ctx, draft)
    }

    paint()
    const observer = new ResizeObserver(() => paint())
    observer.observe(stage)
    return () => observer.disconnect()
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
    const width = rect.width || 1
    const height = rect.height || 1
    const x = ((event.clientX - rect.left) / width) * BOARD_W
    const y = ((event.clientY - rect.top) / height) * BOARD_H
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10]
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly) return
    event.preventDefault()
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
          <span className="whiteboard-hint">当前只能查看这块白板</span>
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
            {colors.map((item) => (
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
