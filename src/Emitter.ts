import * as ts from 'typescript';
import { Dictionary } from './Dictionary';
import { warn } from './logger';
import { assertNever } from './assert_never';
import { isClassDoclet, isNamespaceDoclet, isEnumDoclet } from './doclet_utils';
import {
    createClass,
    createFunction,
    createClassMethod,
    createInterfaceMethod,
    createInterface,
    createClassMember,
    createInterfaceMember,
    createNamespaceMember,
    createModule,
    createNamespace,
    createTypedef,
    createEnum,
} from './create_helpers';

interface IDocletTreeNode
{
    doclet: TDoclet;
    children: IDocletTreeNode[];
    isNested?: boolean;
}

function shouldMoveOutOfClass(doclet: TDoclet)
{
    return isClassDoclet(doclet)
        || isNamespaceDoclet(doclet)
        || isEnumDoclet(doclet)
        || doclet.kind === 'typedef';
}

export class Emitter
{
    results: ts.Node[] = [];

    private _customtsd: string = '';
    private _treeRoots: IDocletTreeNode[] = [];
    private _treeNodes: Dictionary<IDocletTreeNode> = {};

    // resolutionNeeded: IResolutionMap;

    constructor(public readonly options: ITemplateConfig)
    { }

    parse(docs?: TAnyDoclet[])
    {
        this.results = [];
        this._treeRoots = [];
        this._treeNodes = {};

        if (!docs)
            return;

        this._collectCustomTSD(docs);
        this._createTreeNodes(docs);
        this._buildTree(docs);
        this._parseTree();
    }

    emit()
    {
        const resultFile = ts.createSourceFile(
            'types.d.ts',
            '',
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.TS);

        const printer = ts.createPrinter({
            removeComments: false,
            newLine: ts.NewLineKind.LineFeed,
        });

        let out2 = '';

        for (let i = 0; i < this.results.length; ++i)
        {
            out2 += printer.printNode(ts.EmitHint.Unspecified, this.results[i], resultFile);
            out2 += '\n\n';
        }

        if (this._customtsd) {
            out2 += this._customtsd;
            out2 += '\n\n';
        }

        return out2;
    }

    private _collectCustomTSD(docs: TAnyDoclet[])
    {
        for (let i = 0; i < docs.length; ++i)
        {
            const doclet = docs[i];
            if (doclet.kind === 'customtsd' && doclet.tags)
            {
                const value = doclet.tags.map(tag => tag.value).join('\n');
                this._customtsd += value + '\n\n';
            }
        }
    }

    private _createTreeNodes(docs: TAnyDoclet[])
    {
        for (let i = 0; i < docs.length; ++i)
        {
            const doclet = docs[i];

            if (doclet.kind === 'package' || this._ignoreDoclet(doclet))
                continue;

            if (!this._treeNodes[doclet.longname])
            {
                this._treeNodes[doclet.longname] = { doclet, children: [] };
            }
        }
    }

    private _buildTree(docs: TAnyDoclet[])
    {
        for (let i = 0; i < docs.length; ++i)
        {
            const doclet = docs[i];

            if (doclet.kind === 'package' || this._ignoreDoclet(doclet))
                continue;

            const obj = this._treeNodes[doclet.longname];

            if (!obj)
            {
                warn('Failed to find doclet node when building tree, this is likely a bug.', doclet);
                continue;
            }

            let interfaceMerge: IDocletTreeNode | null = null;

            // Generate an interface of the same name as the class to perform
            // a namespace merge.
            if (doclet.kind === 'class')
            {
                const impls = doclet.implements || [];
                const mixes = doclet.mixes || [];
                const extras = impls.concat(mixes);

                if (extras.length)
                {
                    const longname = this._getInterfaceKey(doclet.longname);
                    interfaceMerge = this._treeNodes[longname] = {
                        doclet: {
                            kind: 'interface',
                            name: doclet.name,
                            scope: doclet.scope,
                            longname: longname,
                            augments: extras,
                            memberof: doclet.memberof,
                        },
                        children: [],
                    };
                }
            }

            let namespaceMerge: IDocletTreeNode | null = null;

            // Generate an namespace of the same name as the interface/mixin to perform
            // a namespace merge containing any static children (ex members and functions).
            if (doclet.kind === 'interface' || doclet.kind === 'mixin')
            {
                const staticChildren = docs.filter(d => (d as IDocletBase).memberof === doclet.longname && (d as IDocletBase).scope === 'static');
                if (staticChildren.length)
                {
                    const longname = this._getNamespaceKey(doclet.longname);
                    namespaceMerge = this._treeNodes[longname] = {
                        doclet: {
                            kind: 'namespace',
                            name: doclet.name,
                            scope: doclet.scope,
                            longname: longname,
                            memberof: doclet.memberof,
                        },
                        children: [],
                    };

                    staticChildren.forEach(c => (c as IDocletBase).memberof = longname);
                }
            }

            if (doclet.memberof)
            {
                const parent = this._treeNodes[doclet.memberof];

                if (!parent)
                {
                    warn(`Failed to find parent of doclet '${doclet.longname}' using memberof '${doclet.memberof}', this is likely due to invalid JSDoc.`, doclet);
                    continue;
                }

                const isParentClassLike = isClassDoclet(parent.doclet);

                // We need to move this into a module of the same name as the parent
                if (isParentClassLike && shouldMoveOutOfClass(doclet))
                {
                    const mod = this._getOrCreateClassNamespace(parent);

                    if (interfaceMerge)
                        mod.children.push(interfaceMerge);
                    if (namespaceMerge)
                        mod.children.push(namespaceMerge);

                    mod.children.push(obj);
                }
                else
                {
                    const isObjModuleLike = isNamespaceDoclet(doclet);
                    const isParentModuleLike = isNamespaceDoclet(parent.doclet);

                    if (isObjModuleLike && isParentModuleLike)
                        obj.isNested = true;

                    const isParentEnum = isEnumDoclet(parent.doclet);

                    if (!isParentEnum)
                    {
                        if (interfaceMerge)
                            parent.children.push(interfaceMerge);
                        if (namespaceMerge)
                            parent.children.push(namespaceMerge);

                        parent.children.push(obj);
                    }
                }
            }
            else
            {
                if (interfaceMerge)
                    this._treeRoots.push(interfaceMerge);
                if (namespaceMerge)
                    this._treeRoots.push(namespaceMerge);

                this._treeRoots.push(obj);
            }
        }
    }

    private _parseTree()
    {
        for (let i = 0; i < this._treeRoots.length; ++i)
        {
            const node = this._parseTreeNode(this._treeRoots[i]);

            if (node)
                this.results.push(node);
        }
    }

    private _parseTreeNode(node: IDocletTreeNode, parent?: IDocletTreeNode): ts.Node | null
    {
        const children: ts.Node[] = [];

        if (children)
        {
            for (let i = 0; i < node.children.length; ++i)
            {
                const childNode = this._parseTreeNode(node.children[i], node);

                if (childNode)
                    children.push(childNode);
            }
        }

        switch (node.doclet.kind)
        {
            case 'class':
                return createClass(node.doclet, children);

            case 'constant':
            case 'member':
                if (node.doclet.isEnum)
                    return createEnum(node.doclet);
                else if (parent && parent.doclet.kind === 'class')
                    return createClassMember(node.doclet);
                else if (parent && parent.doclet.kind === 'interface')
                    return createInterfaceMember(node.doclet);
                else
                    return createNamespaceMember(node.doclet);

            case 'callback':
            case 'function':
                if (node.doclet.memberof)
                {
                    const parent = this._treeNodes[node.doclet.memberof];

                    if (parent && parent.doclet.kind === 'class')
                        return createClassMethod(node.doclet);
                    else if (parent && parent.doclet.kind === 'interface')
                        return createInterfaceMethod(node.doclet);
                }
                return createFunction(node.doclet);

            case 'interface':
                return createInterface(node.doclet, children);

            case 'mixin':
                return createInterface(node.doclet, children);

            case 'module':
                return createModule(node.doclet, !!node.isNested, children);

            case 'namespace':
                return createNamespace(node.doclet, !!node.isNested, children);

            case 'typedef':
                return createTypedef(node.doclet, children);

            case 'file':
                return null;

            case 'event':
                // TODO: Handle Events.
                return null;

            case 'customtsd':
                return null; // Ignore, already collected

            default:
                return assertNever(node.doclet);
        }
    }

    private _ignoreDoclet(doclet: TAnyDoclet): boolean
    {
        if (doclet.kind === 'package'
            || doclet.ignore
            || (!this.options.private && doclet.access === 'private')) {
            return true
        }

        if (doclet.access === undefined) {
            return false
        }

        const accessLevels = ["private", "package", "protected", "public"];
        return accessLevels.indexOf(doclet.access.toString()) < accessLevels.indexOf(this.options.access || "package")
    }

    private _getInterfaceKey(longname?: string): string
    {
        return longname ? longname + '$$interface$helper' : '';
    }

    private _getNamespaceKey(longname?: string): string
    {
        return longname ? longname + '$$namespace$helper' : '';
    }

    private _getOrCreateClassNamespace(obj: IDocletTreeNode): IDocletTreeNode
    {
        if (obj.doclet.kind === 'namespace')
            return obj;

        const namespaceKey = this._getNamespaceKey(obj.doclet.longname);
        let mod = this._treeNodes[namespaceKey];

        if (mod)
            return mod;

        mod = this._treeNodes[namespaceKey] = {
            doclet: {
                kind: 'namespace',
                name: obj.doclet.name,
                scope: 'static',
                longname: namespaceKey,
            },
            children: [],
        };

        if (obj.doclet.memberof)
        {
            const parent = this._treeNodes[obj.doclet.memberof];

            if (!parent)
            {
                warn(`Failed to find parent of doclet '${obj.doclet.longname}' using memberof '${obj.doclet.memberof}', this is likely due to invalid JSDoc.`, obj.doclet);
                return mod;
            }

            let parentMod = this._getOrCreateClassNamespace(parent);

            mod.doclet.memberof = parentMod.doclet.longname;
            parentMod.children.push(mod);
        }
        else
        {
            this._treeRoots.push(mod);
        }

        return mod;
    }
}
