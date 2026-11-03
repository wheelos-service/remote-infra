import React, { useState } from 'react'
import { Activity, ClipboardList, Clock, Gauge } from 'lucide-react'
import { useMockFleet } from '../../app/MockFleetProvider'
import { dashboardTasks } from '../../lib/dashboard-data'

type TaskStatus = 'draft' | 'scheduled' | 'running' | 'completed' | 'canceled' | 'unknown' | 'rejected' | 'pending'

interface TaskRecord {
  id: string
  name: string
  vehicleId: string
  type: string
  priority: '高' | '中' | '低'
  status: TaskStatus
  plannedStart: string
  createdBy: string
  createdAt: string
  from: string
  to: string
}

/**
 * Task management center for creating and dispatching missions.
 */
interface TaskCenterProps {
  /** All vehicles available for task dispatch. */
  vehicles: { id: string; name: string }[]
}

/**
 * Task management UI with list and creation form.
 */
const TaskCenter: React.FC<TaskCenterProps> = ({ vehicles }) => {
  const mock = useMockFleet()
  const [selectedTaskId, setSelectedTaskId] = useState<string>('TK-20261023-001')
  const [creating, setCreating] = useState(false)

  const tasks: TaskRecord[] = dashboardTasks(mock.data)

  const selected = tasks.find((t) => t.id === selectedTaskId) ?? tasks[0]

  /**
   * Returns human readable task status label.
   */
  const taskStatusLabel = (status: TaskStatus) => {
    if (status === 'unknown') return '结果未知 · 对账中'
    if (status === 'pending') return '等待设备结果'
    if (status === 'rejected') return '已拒绝'
    if (status === 'draft') return '草稿'
    if (status === 'scheduled') return '已排程'
    if (status === 'running') return '执行中'
    if (status === 'completed') return '已完成'
    return '已取消'
  }

  /**
   * Returns style classes for task status badge.
   */
  const taskStatusClass = (status: TaskStatus) => {
    if (status === 'unknown') {
      return 'bg-amber-950/40 text-amber-200 border-amber-700'
    }
    if (status === 'running') {
      return 'bg-emerald-900/40 text-emerald-200 border-emerald-500/70'
    }
    if (status === 'scheduled') {
      return 'bg-sky-900/40 text-sky-200 border-sky-500/70'
    }
    if (status === 'draft') {
      return 'bg-slate-900 text-slate-300 border-slate-600/70'
    }
    if (status === 'completed') {
      return 'bg-slate-900 text-emerald-200 border-emerald-500/60'
    }
    return 'bg-slate-900 text-slate-400 border-slate-600/70'
  }

  /**
   * Returns style classes for task priority.
   */
  const priorityClass = (priority: TaskRecord['priority']) => {
    if (priority === '高') {
      return 'text-red-300'
    }
    if (priority === '中') {
      return 'text-amber-300'
    }
    return 'text-slate-300'
  }

  const unknownCount = tasks.filter((t) => t.status === 'unknown').length
  const pendingCount = tasks.filter((t) => t.status === 'pending').length
  const completedCount = tasks.filter((t) => t.status === 'completed').length

  return (
    <div data-testid="task-center" className="h-full min-w-0 flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-slate-100">任务管理中心</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-[11px] text-slate-300">
              <ClipboardList className="w-3 h-3" />
              Mock 预览 · 运营任务未接入
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            保留任务列表、详情和新建表单；当前列表为只读技术查询记录，不代表运营任务执行情况。
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          <button type="button" aria-expanded={creating} aria-controls="new-task-form" onClick={() => setCreating(!creating)}
            className="rounded-lg border border-sky-700 px-3 py-1.5 text-sky-200">{creating ? '收起新建任务' : '新建任务'}</button>
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <Activity className="w-3 h-3 text-emerald-300" />
            <span>查询结果未知</span>
            <span className="font-semibold">{unknownCount}</span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <Clock className="w-3 h-3 text-sky-300" />
            <span>查询等待结果</span>
            <span className="font-semibold">{pendingCount}</span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <Gauge className="w-3 h-3 text-amber-300" />
            <span>查询成功</span>
            <span className="font-semibold">{completedCount}</span>
          </div>
        </div>
      </div>

      {/* Main layout: task list + creation form */}
      <div className={`flex-1 min-h-0 grid grid-cols-1 ${creating ? 'xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1.6fr)]' : ''} gap-4`}>
        {/* Task list and detail */}
        <section className="bg-slate-900/70 border border-slate-800 rounded-xl flex flex-col">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300">
            <span className="font-medium">任务列表</span>
            <span className="text-slate-500">
              共 {tasks.length} 条 · 选择任务查看详情
            </span>
          </div>
          <div className="flex-1 min-h-0 grid grid-rows-[minmax(0,1.4fr)_minmax(0,1.2fr)]">
            {/* Upper: list */}
            <div className="overflow-y-auto border-b border-slate-800/80">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => setSelectedTaskId(task.id)}
                  className={[
                    'w-full text-left px-3 py-2 flex flex-col gap-1 border-b border-slate-800/70 hover:bg-slate-900',
                    task.id === selectedTaskId ? 'bg-slate-900/80' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] text-slate-500">{task.id}</span>
                      <span
                        className={[
                          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px]',
                          taskStatusClass(task.status),
                        ].join(' ')}
                      >
                        {task.status === 'completed' ? (
                          <svg
                            className="w-3 h-3 text-emerald-300"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                          >
                            <path
                              d="M6.5 10.5L3.5 7.5L2.5 8.5L6.5 12.5L13.5 5.5L12.5 4.5L6.5 10.5Z"
                              fill="currentColor"
                            />
                          </svg>
                        ) : (
                          <svg
                            className="w-3 h-3 text-sky-300"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                          >
                            <circle cx="8" cy="8" r="6" stroke="currentColor" />
                          </svg>
                        )}
                        {taskStatusLabel(task.status)}
                      </span>
                      <span className="text-xs font-medium text-slate-100 truncate">
                        {task.name}
                      </span>
                    </div>
                    <span className={`text-[11px] ${priorityClass(task.priority)}`}>
                      优先级：{task.priority}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span className="truncate">
                      车辆 {task.vehicleId} · {task.type}
                    </span>
                    <span className="whitespace-nowrap">
                      计划开始 {task.plannedStart}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {/* Lower: selected task detail */}
            {selected ? <div className="p-3 text-xs text-slate-300 overflow-y-auto">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-slate-100">
                      {selected.name}
                    </h2>
                    <span
                      className={[
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px]',
                        taskStatusClass(selected.status),
                      ].join(' ')}
                    >
                      {taskStatusLabel(selected.status)}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    任务 ID {selected.id} · 车辆 {selected.vehicleId}
                  </span>
                </div>
                <div className="flex flex-col items-end text-[11px] text-slate-500">
                  <span>
                    创建人 {selected.createdBy} · {selected.createdAt}
                  </span>
                  <span>计划开始 {selected.plannedStart}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">任务类型</div>
                  <div className="text-[11px] text-slate-200">{selected.type}</div>
                </div>
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">原请求编号</div>
                  <div className="text-[11px] text-slate-200">{selected.from}</div>
                </div>
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">地图标识</div>
                  <div className="text-[11px] text-slate-200">{selected.to}</div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">调度建议</div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    {selected.vehicleId} 的只读查询状态；结果未知不能当作运动完成，不进行实际调度。
                  </p>
                </div>
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">约束与注意事项</div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    当前为技术查询记录，不包含运营路线、进度或完成验收；查询成功不代表车辆完成运动任务。
                  </p>
                </div>
              </div>
            </div> : <PlaceholderSection title="任务详情" description="尚无任务记录，不代表已完成任何任务。" />}
          </div>
        </section>

        {/* Right: new task form */}
        <section id="new-task-form" hidden={!creating} className={`${creating ? 'flex' : 'hidden'} bg-slate-900/70 border border-slate-800 rounded-xl flex-col`}>
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300">
            <span className="font-medium">新建任务（演示表单）</span>
            <span className="text-[11px] text-slate-500">
              配置好参数后，可接入后端调度服务完成真实下发
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 text-xs text-slate-300 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  任务名称
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="例如：东侧路早高峰巡逻"
                />
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  任务类型
                </label>
                <select className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500">
                  <option>巡逻任务</option>
                  <option>物料运输</option>
                  <option>应急支援</option>
                  <option>自定义</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  指定车辆
                </label>
                <select className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500">
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  优先级
                </label>
                <div className="flex gap-1.5">
                  {['高', '中', '低'].map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={[
                        'flex-1 px-2 py-1 rounded-md border text-[11px]',
                        level === '中'
                          ? 'bg-sky-600 text-slate-950 border-sky-500'
                          : 'bg-slate-950 text-slate-300 border-slate-700 hover:border-slate-500',
                      ].join(' ')}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  起点位置
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="例如：物流中心 · 北仓"
                />
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  终点位置
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="例如：生产车间 · 装载区"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  计划开始时间
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="2026-10-23 09:30"
                />
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  其他约束（选填）
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="最大速度 / 路线偏好 / 载重等"
                />
              </div>
            </div>

            <div>
              <label className="block mb-1 text-[11px] text-slate-400">
                任务说明（可见给远程驾驶员和运维人员）
              </label>
              <textarea
                className="w-full h-20 px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500 resize-none"
                placeholder="补充任务背景、特殊安全要求和现场联系人信息等。"
              />
            </div>

            <div className="flex items-center justify-between mt-1 pt-2 border-t border-slate-800">
              <span className="text-[11px] text-slate-500">
                仅监控 Mock 数据，不派发运动任务；保存与下发均未开放。
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled
                  title="Mock 只读，不保存或派发真实任务"
                  className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-[11px] text-slate-200 hover:border-slate-500"
                >
                  保存为草稿
                </button>
                <button
                  type="button"
                  disabled
                  title="Mock 只读，不保存或派发真实任务"
                  className="px-3 py-1.5 rounded-lg border border-sky-500 bg-sky-600 text-[11px] text-slate-950 font-semibold hover:bg-sky-500"
                >
                  下发任务
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

const PlaceholderSection: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <section className="h-full bg-slate-900/70 border border-dashed border-slate-700 rounded-xl p-4 flex flex-col gap-2 text-xs text-slate-300">
    <div className="text-sm font-medium text-slate-100">{title}</div>
    <p className="max-w-2xl leading-relaxed text-slate-400">{description}</p>
    <p className="mt-auto text-[11px] text-slate-500">当前为 Mock 只读数据，不代表真实车辆；未接入的字段保持未知。</p>
  </section>
)

export default TaskCenter
