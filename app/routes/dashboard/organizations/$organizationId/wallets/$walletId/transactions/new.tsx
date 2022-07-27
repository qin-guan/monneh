import type { ActionFunction, LoaderFunction } from '@remix-run/node'
import { json, redirect } from '@remix-run/node'
import invariant from 'tiny-invariant'
import { requireUser } from '~/utils/session.server'
import { requireAuthorization } from '~/utils/authorization.server'
import { db } from '~/utils/db.server'
import type { ThrownResponse } from '@remix-run/react'
import {
    Form,
    useActionData,
    useCatch,
    useLoaderData,
    useSubmit,
    useTransition,
} from '@remix-run/react'
import {
    Autocomplete,
    Button,
    Card,
    Center,
    Grid,
    Group,
    NumberInput,
    SegmentedControl,
    Stack,
    Text,
    Textarea,
} from '@mantine/core'
import { useFormattedCurrency } from '~/hooks/formatter'
import { useForm } from '@mantine/form'
import { useMemo } from 'react'
import { DatePicker } from '@mantine/dates'
import { AutoCompleteItem } from '~/components'
import { useDebounceFn } from 'ahooks'
import * as z from 'zod'
import { getValidationErrorObject } from '~/utils/validation.server'

enum Action {
    UserSearch = 'user-search',
    CreateTransaction = 'create-transaction',
}

interface BaseActionData {
    readonly action: Action
    errors?: Record<string, string>
}

interface UserSearchActionData extends BaseActionData {
    readonly action: Action.UserSearch
    users: { label: string; value: string }[]
}

interface CreateTransactionActionData extends BaseActionData {
    readonly action: Action.CreateTransaction
}

type ActionData = UserSearchActionData | CreateTransactionActionData

enum TransactionType {
    Out = 'out',
    In = 'in',
}

const createTransactionBodySchema = (requesterUsername: string) =>
    z.object({
        type: z.nativeEnum(TransactionType),
        // Epoch time
        spendDateTime: z.string().regex(/^\d+$/).transform(Number),
        transactionValue: z.string().regex(/^\d+$/).transform(Number),
        reviewer: z
            .string()
            .min(1, 'Reviewer is required')
            .refine(
                (value) => value !== requesterUsername,
                'Reviewer cannot be yourself :P'
            ),
        notes: z.string(),
    })

const spendDateTimeSchema = z.number().min(0).max(Date.now())

const transactionValueSchema = z
    .number()
    .min(0, 'Balance must be greater than 0')
    .step(0.01, 'Balance cannot have more than 2 decimal points')

export const action: ActionFunction = async ({ request, params }) => {
    invariant(params.organizationId, 'Expected params.organizationId')
    invariant(params.walletId, 'Expected params.walletId')

    const { username } = await requireUser(request)

    const formData = await request.formData()
    const action = formData.get('action')

    switch (action) {
        case Action.UserSearch: {
            const search = formData.get('search')
            if (!search || typeof search !== 'string') {
                return json<ActionData>({
                    action: Action.UserSearch,
                    users: [],
                })
            }

            const data = await db.user.findMany({
                select: { username: true, firstName: true, lastName: true },
                where: {
                    OR: {
                        username: { search },
                        firstName: { search },
                        lastName: { search },
                        email: { search },
                    },
                    NOT: {
                        username,
                    },
                },
            })

            return json<ActionData>({
                action: Action.UserSearch,
                users: data.map(({ firstName, lastName, username }) => ({
                    label: `${firstName} ${lastName}`,
                    value: username,
                })),
            })
        }

        case Action.CreateTransaction: {
            const object: Record<string, string> = {}
            formData.forEach((value, key) => {
                if (typeof value === 'string') {
                    object[key] = value
                }
            })
            const result = await createTransactionBodySchema(
                username
            ).safeParseAsync(object)
            if (!result.success) {
                return json<ActionData>({
                    action: Action.CreateTransaction,
                    errors: getValidationErrorObject(result.error.issues),
                })
            }

            const transactionValueResult =
                await transactionValueSchema.safeParseAsync(
                    result.data.transactionValue
                )
            if (!transactionValueResult.success) {
                return json<ActionData>({
                    action: Action.CreateTransaction,
                    errors: getValidationErrorObject(
                        transactionValueResult.error.issues
                    ),
                })
            }

            const spendDateTimeResult =
                await spendDateTimeSchema.safeParseAsync(
                    result.data.spendDateTime
                )
            if (!spendDateTimeResult.success) {
                return json<ActionData>({
                    action: Action.CreateTransaction,
                    errors: getValidationErrorObject(
                        spendDateTimeResult.error.issues
                    ),
                })
            }

            const organizationId = parseInt(params.organizationId)
            await requireAuthorization(
                username,
                organizationId,
                (role) => role.allowCreateTransactions
            )

            const walletId = parseInt(params.walletId)
            const wallet = await db.wallet.findUnique({
                where: {
                    id: walletId,
                },
            })

            invariant(wallet, 'Expected wallet')

            const { notes, reviewer, type } = result.data
            if (type === TransactionType.Out) {
                if (wallet.balance.toNumber() < transactionValueResult.data) {
                    return json<ActionData>({
                        action: Action.CreateTransaction,
                        errors: {
                            transactionValue:
                                'The wallet does not have enough balance for this transaction.',
                        },
                    })
                }
                transactionValueResult.data = -transactionValueResult.data
            }

            // Check that the reviewer belongs to the organization & has permissions
            try {
                await requireAuthorization(
                    reviewer,
                    organizationId,
                    (role) => role.allowApproveTransactions
                )
            } catch {
                return json<ActionData>({
                    action: Action.CreateTransaction,
                    errors: {
                        reviewer:
                            'User is not authorized to review your transaction',
                    },
                })
            }

            const { id } = await db.transaction.create({
                data: {
                    notes,
                    approved: false,
                    entryDateTime: new Date(Date.now()),
                    spendDateTime: new Date(spendDateTimeResult.data),
                    transactionValue: transactionValueResult.data,
                    wallet: {
                        connect: {
                            id: walletId,
                        },
                    },
                    creator: {
                        connect: {
                            username,
                        },
                    },
                    reviewer: reviewer
                        ? {
                              connect: {
                                  username: reviewer,
                              },
                          }
                        : {},
                },
            })

            return redirect(
                `/dashboard/organizations/${organizationId}/wallets/${walletId}/transactions/${id}`
            )
        }
    }
}

interface LoaderData {
    wallet: {
        id: number
        name: string
        balance: number
    }
}

type WalletNotFound = ThrownResponse<404, string>
type ThrownResponses = WalletNotFound

export const loader: LoaderFunction = async ({ request, params }) => {
    invariant(params.organizationId, 'Expected params.organizationId')
    invariant(params.walletId, 'Expected params.walletId')

    const organizationId = parseInt(params.organizationId)
    const walletId = parseInt(params.walletId)
    const { username } = await requireUser(request)
    await requireAuthorization(username, organizationId, () => true)

    const wallet = await db.wallet.findFirst({
        select: {
            id: true,
            name: true,
            balance: true,
        },
        where: {
            organizationId,
            id: walletId,
        },
    })
    if (!wallet) throw json('Wallet does not exist', { status: 404 })

    return json<LoaderData>({
        wallet: { ...wallet, balance: wallet.balance.toNumber() },
    })
}

export default function NewTransactionPage() {
    const submit = useSubmit()
    const transition = useTransition()
    const data = useLoaderData<LoaderData>()
    const actionData = useActionData<ActionData>()
    const formattedBalance = useFormattedCurrency(data.wallet.balance)

    const form = useForm({
        initialValues: {
            type: 'in',
            spendDateTime: new Date(),
            transactionValue: 0,
            reviewer: '',
            notes: '',
        },
    })

    const segmentedControlColor = useMemo(
        () => (form.values.type === 'in' ? 'green' : 'red'),
        [form.values.type]
    )

    const { run: runSearch } = useDebounceFn(
        (search: string) => {
            submit({ search, action: Action.UserSearch }, { method: 'post' })
        },
        { wait: 300 }
    )

    const handleAutocompleteChange = (value: string) => {
        form.setFieldValue('reviewer', value)
        runSearch(value)
    }

    return (
        <div>
            <Grid>
                <Grid.Col span={12} md={9}>
                    <Stack>
                        <div>
                            <Text size={'xs'} color={'dimmed'}>
                                {data.wallet.name}
                            </Text>
                            <Text weight={600} size={'xl'}>
                                New transaction
                            </Text>
                        </div>

                        <Form
                            onSubmit={form.onSubmit((values) => {
                                submit(
                                    {
                                        ...values,
                                        action: Action.CreateTransaction,
                                        transactionValue:
                                            values.transactionValue.toString(),
                                        spendDateTime: values.spendDateTime
                                            .getTime()
                                            .toString(),
                                    },
                                    { method: 'post' }
                                )
                            })}
                        >
                            <Stack spacing={'sm'}>
                                <NumberInput
                                    size={'xl'}
                                    variant={'unstyled'}
                                    precision={2}
                                    min={1}
                                    max={data.wallet.balance}
                                    step={0.05}
                                    sx={(theme) => ({
                                        paddingTop: theme.spacing.sm,
                                        paddingBottom: theme.spacing.sm,
                                        paddingLeft: theme.spacing.md,
                                        paddingRight: theme.spacing.md,
                                        borderRadius: theme.radius.md,
                                        borderColor:
                                            theme.colorScheme === 'dark'
                                                ? theme.colors.dark[6]
                                                : theme.colors.gray[2],
                                        borderStyle: 'solid',
                                        borderWidth: 2,
                                    })}
                                    parser={(value) =>
                                        (value ?? '$ 0').replace(
                                            /\$\s?|(,*)/g,
                                            ''
                                        )
                                    }
                                    formatter={(value) =>
                                        !Number.isNaN(parseFloat(value ?? '0'))
                                            ? `$ ${value}`.replace(
                                                  /\B(?=(\d{3})+(?!\d))/g,
                                                  ','
                                              )
                                            : '$ '
                                    }
                                    error={actionData?.errors?.transactionValue}
                                    {...form.getInputProps('transactionValue')}
                                />

                                <DatePicker
                                    label={'Spend date'}
                                    error={actionData?.errors?.spendDateTime}
                                    {...form.getInputProps('spendDateTime')}
                                />

                                <Autocomplete
                                    label={'Reviewer'}
                                    placeholder={'Username or email'}
                                    itemComponent={AutoCompleteItem}
                                    data={
                                        actionData?.action === Action.UserSearch
                                            ? actionData.users
                                            : []
                                    }
                                    error={actionData?.errors?.reviewer}
                                    {...form.getInputProps('reviewer')}
                                    onChange={handleAutocompleteChange}
                                />

                                <Textarea
                                    label={'Notes'}
                                    placeholder={
                                        "I made this transaction and now we're broke"
                                    }
                                    autosize
                                    minRows={3}
                                    error={actionData?.errors?.notes}
                                    {...form.getInputProps('notes')}
                                />

                                <Group>
                                    <Text>Transaction type:</Text>
                                    <SegmentedControl
                                        data={[
                                            { label: 'Incoming', value: 'in' },
                                            { label: 'Outgoing', value: 'out' },
                                        ]}
                                        color={segmentedControlColor}
                                        error={actionData?.errors?.type}
                                        {...form.getInputProps('type')}
                                    />
                                </Group>

                                <br />

                                <Button
                                    type={'submit'}
                                    color={'indigo'}
                                    loading={
                                        transition.submission?.formData.get(
                                            'action'
                                        ) === Action.CreateTransaction &&
                                        transition.state === 'loading'
                                    }
                                >
                                    Submit for review
                                </Button>
                            </Stack>
                        </Form>
                    </Stack>
                </Grid.Col>

                <Grid.Col span={12} md={3}>
                    <Card>
                        <Text color={'dimmed'}>Balance</Text>
                        <Text size={'xl'} weight={600}>
                            {formattedBalance}
                        </Text>
                    </Card>
                </Grid.Col>
            </Grid>
        </div>
    )
}

export function CatchBoundary() {
    const error = useCatch<ThrownResponses>()

    return (
        <Center
            component={'section'}
            sx={(theme) => ({
                backgroundColor:
                    theme.colorScheme === 'dark'
                        ? theme.fn.rgba(theme.colors.red[9], 0.5)
                        : theme.colors.red[4],
                height: '100%',
            })}
        >
            <Text weight={600} size={'xl'}>
                {error.status} {error.data}
            </Text>
        </Center>
    )
}