import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { CostDisplay } from "../../components/shared/cost-display";
import { PhasePipeline } from "../../components/shared/phase-pipeline";
import { StateBadge } from "../../components/shared/state-badge";
import { TimeAgo } from "../../components/shared/time-ago";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/formatters";
import { ROUTES } from "../../lib/routes";
import type { TaskListItem } from "../../types/api";

const columns: ColumnDef<TaskListItem>[] = [
  {
    accessorKey: "title",
    header: "Task",
    cell: ({ row }) => (
      <div className="max-w-[300px]">
        <div className="truncate font-medium text-foreground">{row.original.title}</div>
        <div className="truncate text-[11px] text-muted-foreground/70">{row.original.id}</div>
      </div>
    ),
  },
  {
    accessorKey: "state",
    header: "State",
    cell: ({ row }) => <StateBadge state={row.original.state} />,
    size: 120,
  },
  {
    id: "phase",
    header: "Phase",
    cell: ({ row }) => <PhasePipeline currentPhase={row.original.phase} phasesRan={row.original.phases_ran} />,
    size: 220,
  },
  {
    accessorKey: "llm_cost_usd",
    header: ({ column }) => <SortButton column={column} label="Cost" />,
    cell: ({ row }) => <CostDisplay amount={row.original.llm_cost_usd} size="sm" />,
    size: 80,
  },
  {
    accessorKey: "llm_tokens",
    header: ({ column }) => <SortButton column={column} label="Tokens" />,
    cell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {formatTokens(row.original.llm_tokens)}
      </span>
    ),
    size: 80,
  },
  {
    accessorKey: "last_transition_at",
    header: ({ column }) => <SortButton column={column} label="Last Activity" />,
    cell: ({ row }) => <TimeAgo timestamp={row.original.last_transition_at} />,
    size: 100,
  },
];

interface TaskTableProps {
  tasks: TaskListItem[];
}

/** Sortable data table displaying task rows with state, phase, cost, and token columns. */
export function TaskTable({ tasks }: TaskTableProps): React.JSX.Element {
  const navigate = useNavigate();
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data: tasks,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id} style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className={cn("cursor-pointer", row.original.state === "blocked" && "bg-amber-500/5")}
            onClick={() => navigate(ROUTES.taskDetail(row.original.id))}
          >
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SortButton({
  column,
  label,
}: {
  column: { toggleSorting: (desc?: boolean) => void; getIsSorted: () => false | "asc" | "desc" };
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:text-foreground"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label}
      <ArrowUpDown size={12} className="opacity-50" />
    </button>
  );
}
