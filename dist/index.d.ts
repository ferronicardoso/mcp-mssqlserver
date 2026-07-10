#!/usr/bin/env node
interface PlanOperator {
    physicalOp: string;
    logicalOp: string;
    estimatedRows?: number;
    estimatedSubtreeCost: number;
    object?: string;
    lookup?: boolean;
}
interface MissingIndexSuggestion {
    impact?: number;
    table?: string;
    equalityColumns: string[];
    inequalityColumns: string[];
    includeColumns: string[];
    suggestedCreateStatement?: string;
}
interface StatementAnalysis {
    statementText: string;
    estimatedRows?: number;
    estimatedCost?: number;
    operators: PlanOperator[];
    warnings: string[];
    issues: string[];
    missingIndexes: MissingIndexSuggestion[];
}
export declare function parseShowplan(xml: string): StatementAnalysis[];
export {};
//# sourceMappingURL=index.d.ts.map